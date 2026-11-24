import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeLookup,
  makeGetDefinition,
  collectTaskObjects,
  buildUserPrompt,
  nowStamp,
  stampHeader,
  stampRoleFields,
  stampFixItem,
  buildCrash,
  isNotFoundError,
  snapshotDefinitions,
  toolCallVerdict,
  stripL1Headers,
  hasHeadings,
  numberL1Headers,
  hasOpenFence,
  readLatestSnapshot,
} from '../src/driver.js';
import type { TFdMcpClient } from '../src/mcp.js';
import { textToStructure } from 'flowdini-spec';

function mockMcp(call: (tool: string, args: Record<string, unknown>) => string): TFdMcpClient {
  return { tools: [], call: async (t, a) => call(t, a), close: async () => {} };
}

const foundDef = (def: string) => JSON.stringify({ ok: true, definitions: [{ definition: def }] });
const notFound = (name: unknown) => {
  throw new Error(`объект "${String(name)}" не найден`);
};

describe('isNotFoundError', () => {
  it('русский «не найден» — true', () => {
    expect(isNotFoundError(new Error('procedure "x" не найден'))).toBe(true);
  });
  it('not_found — true', () => {
    expect(isNotFoundError(new Error('not_found'))).toBe(true);
  });
  it('сбой соединения — false', () => {
    expect(isNotFoundError(new Error('connection refused'))).toBe(false);
  });
  it('database does not exist — false (сбой БД, не «объекта нет»)', () => {
    expect(isNotFoundError(new Error('database "x" does not exist'))).toBe(false);
  });
  it('connection not found — false (сбой подключения, не «объекта нет»)', () => {
    expect(isNotFoundError(new Error('connection "x" not found'))).toBe(false);
  });
});

describe('makeLookup', () => {
  it('найденная процедура → exists:true, kind:procedure', async () => {
    const mcp = mockMcp((tool, args) => {
      expect(tool).toBe('get_definition');
      if (args.objectType === 'procedure') return foundDef('CREATE PROCEDURE dbo.sp_x AS BEGIN SELECT 1 END');
      notFound(args.name);
      return '';
    });
    const lookup = makeLookup(mcp, 'mssql');
    await expect(lookup('dbo.sp_x')).resolves.toEqual({ exists: true, kind: 'procedure' });
  });

  it('объект отсутствует (все три типа not_found) → exists:false', async () => {
    const mcp = mockMcp((_t, args) => {
      notFound(args.name);
      return '';
    });
    const lookup = makeLookup(mcp, 'mssql');
    await expect(lookup('dbo.missing')).resolves.toEqual({ exists: false, kind: null });
  });

  it('сбой соединения → exists:null (не «not found»)', async () => {
    const mcp = mockMcp(() => {
      throw new Error('connection refused');
    });
    const lookup = makeLookup(mcp, 'mssql');
    await expect(lookup('dbo.sp_x')).resolves.toEqual({ exists: null, kind: null });
  });
  it('ok:false в JSON — сбой, exists:null (не «объекта нет»)', async () => {
    const mcp = mockMcp(() => JSON.stringify({ ok: false, note: 'connection lost' }));
    const lookup = makeLookup(mcp, 'mssql');
    await expect(lookup('dbo.sp_x')).resolves.toEqual({ exists: null, kind: null });
  });
  it('трёхчастный obj-path с БД, не совпадающей с connection → exists:null с причиной (префикс не игнорируем)', async () => {
    const mcp = mockMcp(() => {
      throw new Error('не должен вызываться');
    });
    const lookup = makeLookup(mcp, 'mssql');
    await expect(lookup('otherdb.dbo.sp_x')).resolves.toEqual({
      exists: null,
      kind: null,
      reason: 'obj-path otherdb.dbo.sp_x: база "otherdb" не совпадает с connection "mssql"',
    });
  });
});

describe('makeGetDefinition', () => {
  it('возвращает определение', async () => {
    const mcp = mockMcp((_t, args) => {
      if (args.objectType === 'procedure') return foundDef('CREATE PROCEDURE dbo.sp_x AS BEGIN SELECT 1 END');
      notFound(args.name);
      return '';
    });
    const get = makeGetDefinition(mcp, 'mssql');
    await expect(get('dbo.sp_x')).resolves.toBe('CREATE PROCEDURE dbo.sp_x AS BEGIN SELECT 1 END');
  });

  it('not_found по всем типам → бросает «не найден»', async () => {
    const mcp = mockMcp((_t, args) => {
      notFound(args.name);
      return '';
    });
    const get = makeGetDefinition(mcp, 'mssql');
    await expect(get('dbo.x')).rejects.toThrow('не найден');
  });

  it('сбой соединения пробрасывается наружу', async () => {
    const mcp = mockMcp(() => {
      throw new Error('connection refused');
    });
    const get = makeGetDefinition(mcp, 'mssql');
    await expect(get('dbo.x')).rejects.toThrow('connection refused');
  });
  it('ok:false в JSON — сбой, не «объекта нет»', async () => {
    const mcp = mockMcp(() => JSON.stringify({ ok: false }));
    const get = makeGetDefinition(mcp, 'mssql');
    await expect(get('dbo.x')).rejects.toThrow('ok:false');
  });
  it('пустое определение — сбой, не «пустой» текст', async () => {
    const mcp = mockMcp(() => JSON.stringify({ ok: true, definitions: [{ definition: '   ' }] }));
    const get = makeGetDefinition(mcp, 'mssql');
    await expect(get('dbo.x')).rejects.toThrow('пустое определение');
  });
  it('трёхчастный obj-path с БД, не совпадающей с connection → бросает', async () => {
    const mcp = mockMcp(() => {
      throw new Error('не должен вызываться');
    });
    const get = makeGetDefinition(mcp, 'mssql');
    await expect(get('otherdb.dbo.sp_x')).rejects.toThrow('не совпадает с connection');
  });
});

describe('collectTaskObjects', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fd-driver-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('читает только issue-app.md, игнорирует result-app.md и chat.md', async () => {
    const obj = (path: string) =>
      `# ISSUE 1\n\n## OBJECT 1\n[obj-kind:: procedure] [obj-action:: create] [obj-path:: ${path}]\n\nbody\n`;
    await writeFile(join(dir, 'issue-app.md'), obj('dbo.p_a'));
    await writeFile(join(dir, 'result-app.md'), obj('dbo.v_b'));
    await writeFile(join(dir, 'chat.md'), obj('dbo.ignore'));
    const objs = await collectTaskObjects(dir);
    expect(objs.map((o) => o.objPath)).toEqual(['dbo.p_a']);
  });

  it('рекурсивно находит в подпапке', async () => {
    const sub = join(dir, 'vault');
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, 'issue-app.md'),
      '# ISSUE 1\n\n## OBJECT 1\n[obj-kind:: function] [obj-action:: create] [obj-path:: dbo.deep]\n\nbody\n',
    );
    const objs = await collectTaskObjects(dir);
    expect(objs.some((o) => o.objPath === 'dbo.deep')).toBe(true);
  });

  it('дедуп по obj-path внутри issue-app.md', async () => {
    const a = '# ISSUE 1\n\n## OBJECT 1\n[obj-kind:: procedure] [obj-action:: create] [obj-path:: dbo.dup]\n\nbody\n\n## OBJECT 2\n[obj-kind:: procedure] [obj-action:: edit] [obj-path:: dbo.dup]\n\nbody\n';
    await writeFile(join(dir, 'issue-app.md'), a);
    const objs = await collectTaskObjects(dir);
    expect(objs.filter((o) => o.objPath === 'dbo.dup').length).toBe(1);
  });

  it('не заходит в snapshots/ и скрытые каталоги', async () => {
    const snap = join(dir, 'snapshots');
    await mkdir(snap, { recursive: true });
    await writeFile(join(snap, 'issue-app.md'), '# ISSUE 1\n\n## OBJECT 1\n[obj-kind:: procedure] [obj-action:: create] [obj-path:: dbo.snap]\n\nbody\n');
    const objs = await collectTaskObjects(dir);
    expect(objs.some((o) => o.objPath === 'dbo.snap')).toBe(false);
  });
});

describe('snapshotDefinitions', () => {
  const obj = (objPath: string) => ({ objPath, objKind: 'procedure' as const, objAction: 'edit' as const });

  it('найденные → в снапшот, ошибок нет', async () => {
    const errors: string[] = [];
    const defs = await snapshotDefinitions([obj('dbo.a'), obj('dbo.b')], async (p) => `DEF ${p}`, errors);
    expect(defs).toEqual([
      { objPath: 'dbo.a', definition: 'DEF dbo.a' },
      { objPath: 'dbo.b', definition: 'DEF dbo.b' },
    ]);
    expect(errors).toEqual([]);
  });

  it('not_found → «объекта нет в БД», объект пропущен', async () => {
    const errors: string[] = [];
    const defs = await snapshotDefinitions(
      [obj('dbo.a')],
      async () => {
        notFound('dbo.a');
        return '';
      },
      errors,
    );
    expect(defs).toEqual([]);
    expect(errors).toEqual(['snapshot: dbo.a: объекта нет в БД']);
  });

  it('сбой MCP → ошибка с текстом, объект пропущен', async () => {
    const errors: string[] = [];
    const defs = await snapshotDefinitions(
      [obj('dbo.a')],
      async () => {
        throw new Error('connection refused');
      },
      errors,
    );
    expect(defs).toEqual([]);
    expect(errors).toEqual(['snapshot: dbo.a: connection refused']);
  });
});

describe('buildUserPrompt', () => {
  it('CODE: хост пишет заголовок, LLM — только тело', () => {
    const p = buildUserPrompt('AI.CODER.JUNIOR', 'журнал', 'CODE', 'ISSUE 1', 1);
    expect(p).toContain('проставляет хост');
    expect(p).toContain('только тело');
    expect(p).not.toContain('[fd-from:: AI.CODER.JUNIOR]');
    expect(p).not.toContain('Напиши раздел «# CODE 1»');
  });

  it('REVIEW подсказывает вложенные ## BUG N и роль ревьюера', () => {
    const p = buildUserPrompt('AI.REVIEWER', 'журнал', 'REVIEW', 'CODE 1', 2);
    expect(p).toContain('## BUG N');
    expect(p).toContain('AI.CODER.SENIOR');
    expect(p).toContain('проставляет хост');
  });

  it('FIX подсказывает вложенные заголовки и fd-to:: AI.REVIEWER', () => {
    const p = buildUserPrompt('AI.CODER.SENIOR', 'журнал', 'FIX', 'REVIEW 1#BUG 1', 2);
    expect(p).toContain('AI.CODER.SENIOR');
    expect(p).toContain('fd-to:: AI.REVIEWER');
    expect(p).toContain('проставляет хост');
  });

  it('accept-ответ НЕ `+` (отказ) — НЕ велит писать DONE от AI, а вернуть человеку', () => {
    const p = buildUserPrompt('AI.ANALYST', 'журнал', null, 'ANSWERS 1#A 1', 2, { acceptAnswer: false });
    expect(p).toContain('отказ → QUESTIONS к человеку');
    expect(p).not.toContain('отказ → DONE');
    expect(p).toContain('DONE поставит сам человек');
  });

  it('accept-ответ `+` — передать задание дальше (ISSUE)', () => {
    const p = buildUserPrompt('AI.ANALYST', 'журнал', null, 'ANSWERS 1#A 1', 2, { acceptAnswer: true });
    expect(p).toContain('Передай задание дальше (ISSUE)');
  });
});

describe('nowStamp', () => {
  it('каноничный ISO8601 без миллисекунд', () => {
    const s = nowStamp(() => new Date('2026-11-23T10:20:30.456Z'));
    expect(s).toBe('2026-11-23T10:20:30Z');
  });
});

describe('stampHeader', () => {
  const now = () => new Date('2026-11-23T10:20:30.456Z');

  it('CODE — заголовок + все свойства (fd-from, fd-createdAt, fd-to, fd-reply)', () => {
    const h = stampHeader('CODE', 'AI.CODER.JUNIOR', 2, ['ISSUE 3'], now);
    expect(h).toBe(
      '# CODE 2\n[fd-from:: AI.CODER.JUNIOR] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-to:: AI.REVIEWER] [fd-reply:: [[#ISSUE 3]]]\n\n',
    );
  });

  it('REVIEW — закрывает дугу детерминированно (fd-from + fd-reply), FIX — контейнер', () => {
    expect(stampHeader('REVIEW', 'AI.REVIEWER', 1, ['CODE 1'], now)).toBe(
      '# REVIEW 1\n[fd-from:: AI.REVIEWER] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-reply:: [[#CODE 1]]]\n\n',
    );
    expect(stampHeader('FIX', 'AI.CODER.SENIOR', 1, ['REVIEW 1#BUG 1'], now)).toBe('# FIX 1\n\n');
  });

  it('REVIEW — список fd-reply закрывает ВСЕ дуги item-FIX (претензия 1)', () => {
    expect(stampHeader('REVIEW', 'AI.REVIEWER', 2, ['FIX 2#BUG 1', 'FIX 2#BUG 2'], now)).toBe(
      '# REVIEW 2\n[fd-from:: AI.REVIEWER] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-reply:: [[#FIX 2#BUG 1]] [[#FIX 2#BUG 2]]]\n\n',
    );
  });

  it('null (аналитик сам решает) — пусто, LLM пишет всё', () => {
    expect(stampHeader(null, 'AI.ANALYST', 1, ['ISSUE 1'], now)).toBe('');
  });
});

describe('buildCrash', () => {
  it('маркер без свойств; ошибки и ответ AI — в ~~~-fence', () => {
    const c = buildCrash(['chat.md: broken link: "[[#ISSUE 9]]"'], '## BUG\n[fd-from:: AI.REVIEWER]');
    expect(c).toBe(
      '# CRASH 1\n\nПроцесс остановлен из-за непредвиденной ошибки. Разбери, исправь, удали этот раздел и перезапусти.\n\nОшибки:\n\n~~~\nchat.md: broken link: "[[#ISSUE 9]]"\n~~~\n\nОтвет AI, породивший ошибки:\n\n~~~\n## BUG\n[fd-from:: AI.REVIEWER]\n~~~',
    );
  });

  it('без ответа AI — только ошибки, подписи «Ответ AI» нет', () => {
    const c = buildCrash(['ошибка']);
    expect(c).toContain('# CRASH 1');
    expect(c).toContain('~~~\nошибка\n~~~');
    expect(c).not.toContain('Ответ AI');
  });

  it('без ошибок и ответа — только маркер и подсказка', () => {
    const c = buildCrash([]);
    expect(c).toContain('# CRASH 1');
    expect(c).not.toContain('~~~');
  });

  it('адаптивный fence: серия ~ в ответе AI не закрывает ограду преждевременно', () => {
    const c = buildCrash(['ошибка'], 'внутри ~~~~ и ещё ~~~~~~');
    // fence длиннее самой длинной серии ~ (6) → 7 тильд, иначе «~~~~~~» закрыл бы ограду.
    expect(c).toContain('~~~~~~~\nвнутри ~~~~ и ещё ~~~~~~\n~~~~~~~');
  });
});

describe('stripL1Headers', () => {
  it('срезает L1-заголовки вне fence; ## и тело остаются', () => {
    const out = stripL1Headers('описание\n# ISSUE 7\n[fd-from:: AI.CODER.JUNIOR]\n\n## BUG 1\nтекст');
    expect(out).not.toContain('# ISSUE 7');
    expect(out).toContain('## BUG 1');
    expect(out).toContain('описание');
    expect(out).toContain('текст');
  });

  it('не трогает # внутри ```-fence (SQL-комментарий)', () => {
    const out = stripL1Headers('```sql\n# это комментарий\nSELECT 1\n```\nпосле');
    expect(out).toContain('# это комментарий');
    expect(out).toContain('после');
  });

  it('не трогает # внутри ~~~-fence, но срезает снаружи', () => {
    const out = stripL1Headers('~~~\n# внутри\n~~~\n# снаружи');
    expect(out).toContain('# внутри');
    expect(out).not.toContain('# снаружи');
  });

  it('отступ 4 пробела — не заголовок (не срезается)', () => {
    const out = stripL1Headers('    # не заголовок\nтекст');
    expect(out).toContain('# не заголовок');
  });

  it('голый # — L1-заголовок, срезается', () => {
    const out = stripL1Headers('#\nтекст');
    expect(out).not.toContain('#');
    expect(out).toContain('текст');
  });

  it('#### (4 #) — не заголовок ATX (HEADING_RE — до 3), не срезается', () => {
    const out = stripL1Headers('#### x\nтекст');
    expect(out).toContain('#### x');
  });

  it('fence закрывается только маркером той же/большей длины', () => {
    const out = stripL1Headers('`````\n```\n# внутри\n`````\n# снаружи');
    expect(out).toContain('# внутри');
    expect(out).not.toContain('# снаружи');
  });
});

describe('hasHeadings', () => {
  it('L2-заголовок вне fence — true', () => {
    expect(hasHeadings('текст\n## BUG 1\nещё')).toBe(true);
  });

  it('L1-заголовок — true', () => {
    expect(hasHeadings('# ISSUE 1\nтекст')).toBe(true);
  });

  it('обычный текст без заголовков — false', () => {
    expect(hasHeadings('просто текст\nещё строка')).toBe(false);
  });

  it('заголовок внутри fence — false', () => {
    expect(hasHeadings('```sql\n# комментарий\nSELECT 1\n```')).toBe(false);
  });
});

describe('stampRoleFields', () => {
  const now = () => new Date('2026-11-23T10:20:30.456Z');

  it('REVIEW: добавляет fd-from/fd-createdAt, сохраняет fd-to/fd-reply, каноничный порядок', () => {
    const body = '## BUG 1\n[fd-to:: AI.CODER.SENIOR] [fd-reply:: [[#CODE 1]]]\n\nописание бага';
    const out = stampRoleFields(body, 'AI.REVIEWER', now);
    expect(out).toBe(
      '## BUG 1\n[fd-from:: AI.REVIEWER] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-to:: AI.CODER.SENIOR] [fd-reply:: [[#CODE 1]]]\n\nописание бага',
    );
  });

  it('перезаписывает неверные fd-from/fd-createdAt, написанные LLM', () => {
    const body = '## BUG 1\n[fd-from:: AI.WRITER] [fd-createdAt:: 2000-01-01T00:00:00Z] [fd-to:: AI.CODER.SENIOR]\n\nбаг';
    const out = stampRoleFields(body, 'AI.REVIEWER', now);
    expect(out).toContain('[fd-from:: AI.REVIEWER]');
    expect(out).toContain('[fd-createdAt:: 2026-11-23T10:20:30Z]');
    expect(out).not.toContain('AI.WRITER');
    expect(out).not.toContain('2000-01-01');
  });

  it('контейнер без свойств и тела не получает fd-from/fd-createdAt', () => {
    const out = stampRoleFields('# ANSWERS 1', 'AI.ANALYST', now);
    expect(out).toBe('# ANSWERS 1');
  });

  it('null-кейс: L1 (fd-reply) и вложенный ## Q (fd-to) оба получают поля', () => {
    const body = '# QUESTIONS 1\n[fd-reply:: [[#ISSUE 1]]]\n\n## Q 1\n[fd-to:: HUMAN.ANALYST]\n\nвопрос';
    const out = stampRoleFields(body, 'AI.ANALYST', now);
    expect(out).toBe(
      '# QUESTIONS 1\n[fd-from:: AI.ANALYST] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-reply:: [[#ISSUE 1]]]\n\n## Q 1\n[fd-from:: AI.ANALYST] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-to:: HUMAN.ANALYST]\n\nвопрос',
    );
  });

  it('пустой текст возвращается как есть', () => {
    expect(stampRoleFields('', 'AI.REVIEWER', now)).toBe('');
    expect(stampRoleFields('  \n', 'AI.REVIEWER', now)).toBe('  \n');
  });
});

describe('stampFixItem', () => {
  const now = () => new Date('2026-11-23T10:20:30.456Z');

  it('формирует подзаголовок и все свойства по дуге; модель — только тело', () => {
    const out = stampFixItem('исправлено: добавлен индекс', 'AI.CODER.SENIOR', 2, 'REVIEW 1#BUG 3', now);
    expect(out).toBe(
      '# FIX 2\n\n## BUG 3\n[fd-from:: AI.CODER.SENIOR] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-to:: AI.REVIEWER] [fd-reply:: [[#REVIEW 1#BUG 3]]]\n\nисправлено: добавлен индекс',
    );
  });

  it('дуга без подзаголовка (L1 REVIEW) — fallback ставит fd-reply на L1-дугу (R10)', () => {
    const out = stampFixItem('исправлено: добавлен индекс', 'AI.CODER.SENIOR', 1, 'REVIEW 1', now);
    expect(out).toBe(
      '# FIX 1\n\n[fd-from:: AI.CODER.SENIOR] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-to:: AI.REVIEWER] [fd-reply:: [[#REVIEW 1]]]\n\nисправлено: добавлен индекс',
    );
  });
});

describe('buildUserPrompt: fixMode/item', () => {
  const journal = '# ISSUE 1\n\nb\n';

  it('item — инструкция «только тело», без вложенных заголовков, дуга одна', () => {
    const p = buildUserPrompt('AI.CODER.SENIOR', journal, 'FIX', 'REVIEW 1#BUG 2', 1, { fixMode: 'item' });
    expect(p).toContain('только тело фикса');
    expect(p).not.toContain('Пиши вложенные заголовки');
    expect(p).toContain('отвечает на дугу «REVIEW 1#BUG 2»');
  });

  it('bulk — инструкция вложенных заголовков и «все замечания», без фокуса на одну дугу', () => {
    const p = buildUserPrompt('AI.CODER.SENIOR', journal, 'FIX', 'REVIEW 1', 1, { fixMode: 'bulk' });
    expect(p).toContain('Пиши вложенные заголовки');
    expect(p).not.toContain('только тело фикса');
    expect(p).toContain('ВСЕ открытые замечания');
    expect(p).not.toContain('отвечает на дугу');
  });

  it('item + справка — справка попадает в промпт', () => {
    const ref = 'Замечание «BUG 1»:\n\n## BUG 1\n[fd-from:: AI.REVIEWER]';
    const p = buildUserPrompt('AI.CODER.SENIOR', journal, 'FIX', 'REVIEW 1#BUG 2', 1, { fixMode: 'item', fixReference: ref });
    expect(p).toContain('Справка');
    expect(p).toContain('Замечание «BUG 1»');
    expect(p).toContain(ref);
  });

  it('item без справки — секции «Справка» нет', () => {
    const p = buildUserPrompt('AI.CODER.SENIOR', journal, 'FIX', 'REVIEW 1#BUG 2', 1, { fixMode: 'item' });
    expect(p).not.toContain('Справка');
  });
});

describe('buildUserPrompt: accept-политика', () => {
  const journal = '# ANSWERS 1\n\n## A 1\n[fd-from:: HUMAN.ANALYST]\n\n+\n';

  it('accept (`+`) — «передай дальше», не «разбери»', () => {
    const p = buildUserPrompt('AI.ANALYST', journal, null, 'ANSWERS 1#A 1', 1, { acceptAnswer: true });
    expect(p).toContain('детерминированный accept');
    expect(p).toContain('Передай задание дальше');
    expect(p).not.toContain('Разбери его');
  });

  it('не accept — «разбери», правило «только `+`»', () => {
    const p = buildUserPrompt('AI.ANALYST', journal, null, 'ANSWERS 1#A 1', 1, { acceptAnswer: false });
    expect(p).toContain('Разбери его');
    expect(p).toContain('Accept — только ровно `+`');
    expect(p).not.toContain('детерминированный accept');
  });

  it('без acceptAnswer (ISSUE к аналитику) — старая инструкция', () => {
    const p = buildUserPrompt('AI.ANALYST', journal, null, 'ISSUE 1', 1);
    expect(p).toContain('Раздел выбери сам');
    expect(p).not.toContain('accept');
  });
});

describe('toolCallVerdict', () => {
  const allowed = new Set(['execute_sql', 'get_definition']);

  it('недозволенный — forbid и в обычном, и в dry-run', () => {
    expect(toolCallVerdict('drop_table', allowed, false)).toBe('forbid');
    expect(toolCallVerdict('drop_table', allowed, true)).toBe('forbid');
  });

  it('execute_sql в dry-run — skip (БД не трогаем)', () => {
    expect(toolCallVerdict('execute_sql', allowed, true)).toBe('skip');
  });

  it('execute_sql в обычном режиме — execute', () => {
    expect(toolCallVerdict('execute_sql', allowed, false)).toBe('execute');
  });

  it('дозволенный read-only в dry-run — execute', () => {
    expect(toolCallVerdict('get_definition', allowed, true)).toBe('execute');
  });
});

describe('numberL1Headers (R13)', () => {
  const empty = textToStructure('', true);
  const withIssue3 = textToStructure('# ISSUE 3\n\nx\n', true);

  it('голый L1 получает номер', () => {
    expect(numberL1Headers('# ISSUE\n\ntext\n', empty)).toBe('# ISSUE 1\n\ntext\n');
  });

  it('уже нумерованный L1 пере-нумеруется (с учётом существующих)', () => {
    expect(numberL1Headers('# ISSUE 3\n\nx\n', withIssue3)).toBe('# ISSUE 4\n\nx\n');
  });

  it('несколько одноимённых L1 — разные последовательные номера', () => {
    expect(numberL1Headers('# ISSUE\n\na\n# ISSUE\n\nb\n', empty)).toBe('# ISSUE 1\n\na\n# ISSUE 2\n\nb\n');
  });

  it('QUESTIONS нумеруется отдельно от ISSUE', () => {
    expect(numberL1Headers('# ISSUE\n\na\n# QUESTIONS\n\nq\n', empty)).toBe('# ISSUE 1\n\na\n# QUESTIONS 1\n\nq\n');
  });

  it('строки-примеры внутри fence не трогаются', () => {
    const text = '```sql\n# ISSUE 99\n```\n# ISSUE\n\nx\n';
    expect(numberL1Headers(text, empty)).toBe('```sql\n# ISSUE 99\n```\n# ISSUE 1\n\nx\n');
  });

  it('не-ISSUE/QUESTIONS L1 остаётся без номера (R4 валидирует тип отдельно)', () => {
    expect(numberL1Headers('# CODE 5\n\nx\n', empty)).toBe('# CODE 5\n\nx\n');
  });
});

describe('hasOpenFence (R4)', () => {
  it('закрытый fence — false', () => {
    expect(hasOpenFence('```sql\nSELECT 1\n```\n')).toBe(false);
  });

  it('незакрытый fence — true', () => {
    expect(hasOpenFence('```sql\nSELECT 1\n')).toBe(true);
  });

  it('без fence — false', () => {
    expect(hasOpenFence('# ISSUE 1\n\ntext\n')).toBe(false);
  });

  it('~~~ тоже ловится', () => {
    expect(hasOpenFence('~~~\ncode\n')).toBe(true);
  });
});

describe('readLatestSnapshot (R7)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fd-snap-'));
    await mkdir(join(dir, 'snapshots', '1'), { recursive: true });
    await mkdir(join(dir, 'snapshots', '2'), { recursive: true });
    await mkdir(join(dir, 'snapshots', 'baseline'), { recursive: true });
    await writeFile(join(dir, 'snapshots', '1', 'a.sql'), 'CREATE PROCEDURE a\n');
    await writeFile(join(dir, 'snapshots', '2', 'b.sql'), 'CREATE PROCEDURE b\n');
    await writeFile(join(dir, 'snapshots', '2', 'c.sql'), 'CREATE PROCEDURE c\n');
    await writeFile(join(dir, 'snapshots', 'baseline', 'z.sql'), 'CREATE PROCEDURE z\n');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('нет snapshots/ — null', async () => {
    const d2 = await mkdtemp(join(tmpdir(), 'fd-nosnap-'));
    try {
      await expect(readLatestSnapshot(d2)).resolves.toBeNull();
    } finally {
      await rm(d2, { recursive: true, force: true });
    }
  });

  it('берёт максимальный числовой каталог, baseline не считается', async () => {
    const out = await readLatestSnapshot(dir);
    expect(out).not.toBeNull();
    expect(out).toContain('### b.sql');
    expect(out).toContain('### c.sql');
    expect(out).not.toContain('a.sql');
    expect(out).not.toContain('z.sql');
  });

  it('порядок файлов детерминирован (сортировка)', async () => {
    const out = await readLatestSnapshot(dir);
    expect(out).not.toBeNull();
    expect(out!.indexOf('### b.sql')).toBeLessThan(out!.indexOf('### c.sql'));
  });
});

describe('buildUserPrompt: REVIEW (R7/R9)', () => {
  const journal = '# CODE 1\n\nx\n';

  it('одиночная дуга — предупреждение «несколько дуг» не выводится', () => {
    const p = buildUserPrompt('AI.REVIEWER', journal, 'REVIEW', 'CODE 1', 1, { reviewAddrs: ['CODE 1'] });
    expect(p).not.toContain('несколько дуг');
  });

  it('несколько дуг — предупреждение со списком адресов', () => {
    const p = buildUserPrompt('AI.REVIEWER', journal, 'REVIEW', 'CODE 1', 1, { reviewAddrs: ['CODE 1', 'FIX 1'] });
    expect(p).toContain('несколько дуг');
    expect(p).toContain('«CODE 1»');
    expect(p).toContain('«FIX 1»');
  });

  it('снимок попадает в промпт REVIEW', () => {
    const snap = '### dbo.sp_a.sql\nCREATE PROCEDURE dbo.sp_a\n';
    const p = buildUserPrompt('AI.REVIEWER', journal, 'REVIEW', 'CODE 1', 1, { snapshotText: snap });
    expect(p).toContain('Актуальный снимок БД');
    expect(p).toContain(snap);
  });

  it('без снимка — секции «Актуальный снимок» нет', () => {
    const p = buildUserPrompt('AI.REVIEWER', journal, 'REVIEW', 'CODE 1', 1);
    expect(p).not.toContain('Актуальный снимок БД');
  });
});
