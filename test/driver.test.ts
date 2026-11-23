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
} from '../src/driver.js';
import type { TFdMcpClient } from '../src/mcp.js';

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

  it('not_found по всем типам → бросает «definition not found»', async () => {
    const mcp = mockMcp((_t, args) => {
      notFound(args.name);
      return '';
    });
    const get = makeGetDefinition(mcp, 'mssql');
    await expect(get('dbo.x')).rejects.toThrow('definition not found');
  });

  it('сбой соединения пробрасывается наружу', async () => {
    const mcp = mockMcp(() => {
      throw new Error('connection refused');
    });
    const get = makeGetDefinition(mcp, 'mssql');
    await expect(get('dbo.x')).rejects.toThrow('connection refused');
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

  it('читает issue-app.md и result-app.md, игнорирует chat.md', async () => {
    const obj = (path: string) =>
      `# ISSUE 1\n\n## OBJECT 1\n[obj-kind:: procedure] [obj-action:: create] [obj-path:: ${path}]\n\nbody\n`;
    await writeFile(join(dir, 'issue-app.md'), obj('dbo.p_a'));
    await writeFile(join(dir, 'result-app.md'), obj('dbo.v_b'));
    await writeFile(join(dir, 'chat.md'), obj('dbo.ignore'));
    const objs = await collectTaskObjects(dir);
    expect(objs.map((o) => o.objPath).sort()).toEqual(['dbo.p_a', 'dbo.v_b']);
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

  it('дедуп по obj-path', async () => {
    const a = '# ISSUE 1\n\n## OBJECT 1\n[obj-kind:: procedure] [obj-action:: create] [obj-path:: dbo.dup]\n\nbody\n';
    const b = '# ISSUE 1\n\n## OBJECT 1\n[obj-kind:: procedure] [obj-action:: edit] [obj-path:: dbo.dup]\n\nbody\n';
    await writeFile(join(dir, 'issue-app.md'), a);
    await writeFile(join(dir, 'result-app.md'), b);
    const objs = await collectTaskObjects(dir);
    expect(objs.filter((o) => o.objPath === 'dbo.dup').length).toBe(1);
  });
});

describe('snapshotDefinitions', () => {
  const obj = (objPath: string) => ({ objPath, objKind: 'procedure', objAction: 'edit' as const });

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
        throw new Error('definition not found: dbo.a');
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
    const h = stampHeader('CODE', 'AI.CODER.JUNIOR', 2, 'ISSUE 3', now);
    expect(h).toBe(
      '# CODE 2\n[fd-from:: AI.CODER.JUNIOR] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-to:: AI.REVIEWER] [fd-reply:: [[#ISSUE 3]]]\n\n',
    );
  });

  it('REVIEW — закрывает дугу детерминированно (fd-from + fd-reply), FIX — контейнер', () => {
    expect(stampHeader('REVIEW', 'AI.REVIEWER', 1, 'CODE 1', now)).toBe(
      '# REVIEW 1\n[fd-from:: AI.REVIEWER] [fd-createdAt:: 2026-11-23T10:20:30Z] [fd-reply:: [[#CODE 1]]]\n\n',
    );
    expect(stampHeader('FIX', 'AI.CODER.SENIOR', 1, 'REVIEW 1#BUG 1', now)).toBe('# FIX 1\n\n');
  });

  it('null (аналитик сам решает) — пусто, LLM пишет всё', () => {
    expect(stampHeader(null, 'AI.ANALYST', 1, 'ISSUE 1', now)).toBe('');
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

  it('дуга без подзаголовка — fallback на stampRoleFields', () => {
    const out = stampFixItem('## BUG 1\n[fd-to:: AI.REVIEWER]\n\nфикс', 'AI.CODER.SENIOR', 1, 'REVIEW 1', now);
    expect(out).toContain('# FIX 1');
    expect(out).toContain('[fd-from:: AI.CODER.SENIOR]');
    expect(out).toContain('[fd-to:: AI.REVIEWER]');
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
