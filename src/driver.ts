// Драйвер цикла исполнения: nextStep → roleBrief → агент-роль (LLM + MCP) → раздел → taskCheck → снапшот.
import { readFile, writeFile, readdir, rename, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { textToStructure } from 'flowdini-spec';
import type { TFdContent } from 'flowdini-spec';
import {
  contentPretty,
  nextStep,
  roleBrief,
  gateDue,
  taskCheck,
  level1List,
  isCrashed,
  roleCovers,
  resolveRole,
  extractDbObjects,
  validateDbObject,
  collectSnapshot,
  captureSnapshot,
  fixReference,
  acceptOf,
  nowStamp,
} from 'flowdini-engine';
import type { TFdSpecConfig, TFdDbLookup, TFdGetDefinition, TFdRoleSpec, TFdDbObject } from 'flowdini-engine';
import type { TFdProvidersConfig } from './config.js';
import { resolveProvider } from './config.js';
import { runRole } from './agent.js';
import type { TFdMcpClient, TFdMcpTool } from './mcp.js';

export interface TFdRunOptions {
  taskDir: string;
  spec: TFdSpecConfig;
  providers: TFdProvidersConfig;
  mcp?: TFdMcpClient;
  vaultRoot?: string;
  connection?: string;
  maxSteps?: number;
  dryRun?: boolean;
}

export interface TFdRunResult {
  steps: number;
  stoppedFor: string | null;
  errors: string[];
  /** Некритичные замечания прогона (например, недозволенный вызов инструмента). */
  warnings: string[];
  hitMaxSteps: boolean;
  /** dry-run: тексты разделов, которые агент написал бы (не записаны в журнал). */
  drySections: string[];
  /** dry-run: недозволенные вызовы инструментов, которые агент попытался сделать. */
  dryWarnings: string[];
}

const CHAT_FILE = 'chat.md';

function nextL1Number(content: TFdContent, title: string): number {
  let max = 0;
  for (const l1 of level1List(content)) {
    if (l1.title === title && l1.idx > max) max = l1.idx;
  }
  return max + 1;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// Все OBJECT-объекты таска: живут в issue-app.md/result-app.md, а НЕ в chat.md.
// Рекурсивный обход taskDir (vault может быть вложен); дедуп по obj-path.
export async function collectTaskObjects(taskDir: string): Promise<TFdDbObject[]> {
  const seen = new Set<string>();
  const objects: TFdDbObject[] = [];
  const targets = new Set(['issue-app.md', 'result-app.md']);
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (targets.has(e.name)) {
        const text = await readIfExists(p);
        if (text === null) continue;
        for (const o of extractDbObjects(textToStructure(text, true))) {
          if (!seen.has(o.objPath)) {
            seen.add(o.objPath);
            objects.push(o);
          }
        }
      }
    }
  }
  await walk(taskDir);
  return objects;
}

function specLines(spec: TFdRoleSpec): string {
  const parts: string[] = [];
  if (spec.model !== undefined) parts.push(`model: ${spec.model}`);
  if (spec.tools !== undefined && spec.tools.length > 0) parts.push(`tools: ${spec.tools.join(', ')}`);
  if (spec.rights !== undefined) parts.push(`rights: ${JSON.stringify(spec.rights)}`);
  if (spec.budget !== undefined) parts.push(`budget: ${JSON.stringify(spec.budget)}`);
  return parts.length > 0 ? parts.join('\n') : '(оси не заданы)';
}

async function buildSystemPrompt(
  role: string,
  spec: TFdRoleSpec,
  context: string[],
  vault: string[],
  vaultRoot: string,
  gate: boolean,
  connection: string | null,
): Promise<string> {
  const lines: string[] = [];
  lines.push(`Ты — роль «${role}» в процессе разработки по методологии flowdini.`);
  lines.push('');
  lines.push(`Твоя задача — написать РОВНО ОДИН следующий раздел журнала (markdown) в ответ на открытую дугу. Ничего кроме этого раздела: без пояснений, без «вот мой ответ».`);
  lines.push('');
  lines.push('Твои оси (SPEC):');
  lines.push(specLines(spec));
  lines.push('');
  // SPEC-биндинги (доверенный конфиг владельца) — читаем как есть.
  for (const f of context) {
    const p = resolve(vaultRoot, f);
    const text = await readIfExists(p);
    if (text !== null) {
      lines.push(`Контекст из «${f}»:`);
      lines.push('```');
      lines.push(text);
      lines.push('```');
      lines.push('');
    }
  }
  // fd-vault (пользовательский ввод из ISSUE) — не выпускаем за vaultRoot (path traversal, симлинки).
  const vaultReal = await realpath(vaultRoot).catch(() => null);
  for (const f of vault) {
    const p = resolve(vaultRoot, f);
    if (vaultReal === null) continue; // vaultRoot не резолвится — vault недоступен, файл не читаем (fail-closed)
    const rp = await realpath(p).catch(() => null);
    if (rp === null) continue; // файла нет
    if (rp !== vaultReal && !rp.startsWith(vaultReal + sep)) continue; // вне vault
    const text = await readIfExists(p);
    if (text !== null) {
      lines.push(`Контекст из «${f}»:`);
      lines.push('```');
      lines.push(text);
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('Правила формата раздела (строго):');
  lines.push('1. Заголовок L1: `# {РАЗДЕЛ} {N}` (с номером).');
  lines.push('2. Свойства — ОДНОЙ строкой сразу под заголовком, в порядке `fd-from`, `fd-createdAt`, `fd-to`, `fd-reply`.');
  lines.push('3. После строки свойств — пустая строка, затем тело раздела.');
  lines.push('4. Тело — по существу, на русском.');
  lines.push('5. Вложенные заголовки (`##`) — ОБЯЗАТЕЛЬНО с номером: `## ИМЯ N`. Заголовок без номера — ошибка валидации, раздел не примут. Если подзаголовки не нужны, пиши тело обычными абзацами/списками, без `##`.');
  if (gate) {
    lines.push('6. ОБЯЗАТЕЛЬНО: первым вложенным заголовком этого раздела должен быть `## Q N` (с номером, как у прочих вложенных заголовков) к HUMAN.CODER — вопрос, продолжать ли итерацию. Это гейт.');
  }
  lines.push('');
  const rights = spec.rights as Record<string, unknown> | undefined;
  if (connection !== null) {
    lines.push(`Подключение к БД — «${connection}»: передавай его в аргумент \`connection\` каждого инструмента БД (execute_sql / get_definition / …).`);
  }
  if (rights !== undefined) {
    const db = rights.db;
    if (db === 'read') {
      lines.push('Доступ к БД — только чтение (get_definition / describe_*). Не изменяй объекты БД.');
    } else if (Array.isArray(db)) {
      lines.push(`Тебе можно править только эти виды объектов БД: ${db.join(', ')}. DDL таблиц — не трогать.`);
    } else if (typeof db === 'string') {
      lines.push(`Тебе можно править только объекты БД вида «${db}». DDL таблиц — не трогать.`);
    }
  }
  return lines.join('\n');
}

export { nowStamp };

/** L1-заголовок раздела, который проставляет ХОСТ (не LLM), по канону:
 *  - `CODE` — заголовок + свойства (`fd-from`, `fd-createdAt`, `fd-to:: AI.REVIEWER`, `fd-reply`);
 *  - `REVIEW` — заголовок + `fd-from`/`fd-createdAt`/`fd-reply` (детерминированно закрывает
 *    дугу CODE/FIX → AI.REVIEWER; подзаголовки `## BUG/RISK/OTHER` — отдельно);
 *  - `FIX` — заголовок-контейнер без свойств (свойства на вложенных `##`);
 *  - `null` (аналитик сам решает) — пусто: хост не знает раздела, LLM пишет всё.
 *  `now` — источник времени (инъекция для тестов). */
export function stampHeader(
  section: string | null,
  role: string,
  l1Number: number,
  arcAddr: string,
  now: () => Date = () => new Date(),
): string {
  if (section === null) return '';
  const head = `# ${section} ${l1Number}`;
  if (section === 'CODE') {
    return `${head}\n[fd-from:: ${role}] [fd-createdAt:: ${nowStamp(now)}] [fd-to:: AI.REVIEWER] [fd-reply:: [[#${arcAddr}]]]\n\n`;
  }
  if (section === 'REVIEW') {
    // REVIEW закрывает дугу CODE/FIX → AI.REVIEWER детерминированно (fd-from + fd-reply):
    // иначе «замечаний нет» оставляет дугу открытой и nextStep зацикливает REVIEW.
    return `${head}\n[fd-from:: ${role}] [fd-createdAt:: ${nowStamp(now)}] [fd-reply:: [[#${arcAddr}]]]\n\n`;
  }
  return `${head}\n\n`;
}

/**
 * Пост-обработка секции от LLM: ХОСТ перезаписывает детерминированные свойства
 * `fd-from` (= роль) и `fd-createdAt` (= now) на каждом топике-сообщении
 * (есть тело или `fd-from`/`fd-to`/`fd-reply`). `fd-to`/`fd-reply` (зависят от
 * контента/домена) остаются как написал LLM. Возвращает каноничный текст
 * секции через `contentPretty` движка.
 */
export function stampRoleFields(
  text: string,
  role: string,
  now: () => Date = () => new Date(),
): string {
  if (text.trim() === '') return text;
  const content = textToStructure(text, true);
  for (const item of content.itemList) {
    const t = item.topic;
    const isMessage =
      item.text !== null ||
      t.inlineList.some((f) => f.param === 'fd-from' || f.param === 'fd-to' || f.param === 'fd-reply');
    if (!isMessage) continue;
    t.inlineList = t.inlineList.filter(
      (f) => f.source !== 'topic' || (f.param !== 'fd-from' && f.param !== 'fd-createdAt'),
    );
    t.inlineList.push({ param: 'fd-from', valueList: [role], source: 'topic' });
    t.inlineList.push({ param: 'fd-createdAt', valueList: [nowStamp(now)], source: 'topic' });
  }
  return contentPretty(content, now);
}

/** FIX-раздел в режиме `fixMode: item`: ХОСТ формирует подзаголовок `## {ИМЯ} {N}`
 *  и все свойства (`fd-from`=роль, `fd-createdAt`=now, `fd-to:: AI.REVIEWER`,
 *  `fd-reply:: [[#<дуга>]]`) по адресу дуги; модель пишет только тело фикса.
 *  Для дуги без подзаголовка (в FIX не бывает) — fallback на `stampRoleFields`. */
export function stampFixItem(
  body: string,
  role: string,
  l1Number: number,
  arcAddr: string,
  now: () => Date = () => new Date(),
): string {
  const l2 = arcAddr.split('#')[1];
  let inner: string;
  if (l2 !== undefined && l2.trim() !== '') {
    const props = `[fd-from:: ${role}] [fd-createdAt:: ${nowStamp(now)}] [fd-to:: AI.REVIEWER] [fd-reply:: [[#${arcAddr}]]]`;
    inner = `## ${l2}\n${props}\n\n${body.trim()}`;
  } else {
    inner = stampRoleFields(body, role, now).trim();
  }
  return `${stampHeader('FIX', role, l1Number, arcAddr, now)}${inner}`;
}

/** Терминальный маркер аварии `# CRASH 1` (без свойств, хост не притворяется ролью):
 *  ошибки + сырой ответ AI. Обе части — в `~~~`-fence: `taskCheck` не проверяет
 *  ссылки внутри fence (`stripFences`), а `~~~` не конфликтует с ```-блоками SQL,
 *  которые AI пишет в CODE/FIX. */
export function buildCrash(errors: string[], rawAnswer?: string): string {
  const out = [
    '# CRASH 1',
    '',
    'Процесс остановлен из-за непредвиденной ошибки. Разбери, исправь, удали этот раздел и перезапусти.',
  ];
  if (errors.length > 0) {
    out.push('', 'Ошибки:', '', '~~~', ...errors, '~~~');
  }
  if (rawAnswer !== undefined && rawAnswer.trim() !== '') {
    out.push('', 'Ответ AI, породивший ошибки:', '', '~~~', rawAnswer.trimEnd(), '~~~');
  }
  return out.join('\n');
}

/** Доп. контекст промпта хода (per-item FIX). */
export interface TFdPromptOpts {
  /** `fixMode` из SPEC: `item` (по умолчанию) — один FIX на замечание (хост формирует заголовок/свойства); `bulk` — один FIX на все замечания. */
  fixMode?: 'bulk' | 'item';
  /** Текст справки (предыдущие пункты REVIEW + фиксы) при `fixMode: item`. */
  fixReference?: string;
  /** Детерминированный accept-статус дуги-ответа человека (`ANSWERS n#A m`):
   *  `true` — ответ ровно `+`; `false` — иной ответ. `undefined` — дуга не ответ человека. */
  acceptAnswer?: boolean;
}

export function buildUserPrompt(
  role: string,
  journal: string,
  section: string | null,
  arcAddr: string,
  l1Number: number,
  opts?: TFdPromptOpts,
): string {
  const lines: string[] = [];
  lines.push('Журнал таска (chat.md):');
  lines.push('---');
  lines.push(journal);
  lines.push('---');
  lines.push('');
  if (section === 'FIX' && opts?.fixMode !== 'item') {
    lines.push(`Следующий ход: роль «${role}» отвечает на ВСЕ открытые замечания этого ревью сразу (одна секция на все), а не на одну дугу.`);
  } else {
    lines.push(`Следующий ход: роль «${role}» отвечает на дугу «${arcAddr}».`);
  }
  if (section !== null) {
    lines.push(`L1-заголовок «# ${section} ${l1Number}» и его свойства проставляет хост — ты их НЕ пиши, начинай сразу с содержимого.`);
    if (section === 'CODE') {
      lines.push('Напиши только тело раздела (обычные абзацы/списки, без заголовков).');
    } else if (section === 'FIX') {
      if (opts?.fixMode === 'item') {
        lines.push('Напиши только тело фикса для ЭТОГО одного замечания (обычные абзацы/списки, без заголовка «## …» и без свойств). Заголовок «## {ИМЯ} N» и все свойства (`fd-from`/`fd-createdAt`/`fd-to:: AI.REVIEWER`/`fd-reply`) проставит хост.');
      } else {
        lines.push('Пиши вложенные заголовки: под каждое замечание из ревью — «## {ИМЯ} N» (тот же BUG/RISK/OTHER и номер, что в ревью) с телом и свойствами `[fd-to:: AI.REVIEWER] [fd-reply:: [[#<пункт ревью>]]]`. Поля `fd-from`/`fd-createdAt` НЕ пиши — их проставляет хост.');
      }
      if (opts?.fixReference !== undefined && opts.fixReference.trim() !== '') {
        lines.push('');
        lines.push('Справка — предыдущие пункты этого ревью и твои ответы на них (контекст, НЕ задание; эти пункты уже закрыты, их не трогай):');
        lines.push('---');
        lines.push(opts.fixReference);
        lines.push('---');
      }
    } else if (section === 'REVIEW') {
      lines.push(`Если нашёл замечания — под каждое вложенный «## BUG N»/«## RISK N»/«## OTHER N» (только новые, не повторяй уже закрытые) с телом и свойствами \`[fd-to:: AI.CODER.SENIOR] [fd-reply:: [[#${arcAddr}]]]\`. Поля fd-from/fd-createdAt НЕ пиши — их проставляет хост. Если замечаний нет — коротко «замечаний нет» без fd-to (дальше решает человек: DONE или новый ISSUE).`);
    }
  } else if (opts?.acceptAnswer !== undefined) {
    // Разбор ответа человека на вопрос (accept-политика канона): accept — только ровно `+`.
    if (opts.acceptAnswer) {
      lines.push('Ответ человека на эту дугу — ровно `+` (детерминированный accept). Передай задание дальше (ISSUE), не переспрашивай.');
    } else {
      lines.push('Ответ человека на эту дугу — НЕ `+`. Разбери его: замечания/правки → новая итерация QUESTIONS; фактическое согласие («да», «ок») → передай дальше (ISSUE); отказ → QUESTIONS к человеку (перескажи отказ; DONE поставит сам человек или даст новый ISSUE). Accept — только ровно `+`.');
    }
    lines.push('Раздел и свойства fd-to/fd-reply (на дуги-ответы) пиши сам; поля fd-from/fd-createdAt НЕ пиши — их проставляет хост.');
  } else {
    lines.push('Раздел выбери сам (ISSUE → QUESTIONS или передача ISSUE дальше). Пиши заголовок раздела и свойства fd-to/fd-reply (на дугу); поля fd-from/fd-createdAt НЕ пиши — их проставляет хост.');
  }
  return lines.join('\n');
}

export function isNotFoundError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  // Только маркеры «объекта нет» сервера vv-db-mcp (`[not_found] … не найден`).
  // Широкие «not found»/«does not exist» ловили бы «database … does not exist» и
  // «connection not found», выдавая сбой подключения за отсутствие объекта.
  return /not_found|не найден/i.test(msg);
}

const DB_KINDS = ['procedure', 'function', 'view'] as const;

/** obj-path: db.schema.name — БД задаёт `connection`, берём последние две части (schema, name). */
function splitObjPath(objPath: string): { name: string; schema: string | undefined } {
  const parts = objPath.split('.');
  return {
    name: parts[parts.length - 1],
    schema: parts.length >= 2 ? parts[parts.length - 2] : undefined,
  };
}

/** Один вызов `get_definition` по одному objectType.
 * `notfound` — ok:true с пустым definitions (не этот тип) или not_found;
 * `okfalse` — ok:false/нет ok (сбой JSON, не «объекта нет»);
 * `{ definitions }` — найден. Сбой сети/прав пробрасывается. */
type TProbe = 'notfound' | 'okfalse' | { definitions: Array<{ definition?: string }> };

async function probeDefinition(
  mcp: TFdMcpClient,
  connection: string,
  name: string,
  schema: string | undefined,
  kind: string,
): Promise<TProbe> {
  let text: string;
  try {
    text = await mcp.call('get_definition', {
      connection,
      name,
      objectType: kind,
      ...(schema !== undefined ? { schema } : {}),
    });
  } catch (e) {
    if (isNotFoundError(e)) return 'notfound';
    throw e;
  }
  const parsed = JSON.parse(text) as { ok?: boolean; definitions?: Array<{ definition?: string }> };
  if (parsed.ok !== true) return 'okfalse';
  if ((parsed.definitions?.length ?? 0) === 0) return 'notfound';
  return { definitions: parsed.definitions! };
}

export function makeLookup(mcp: TFdMcpClient, connection: string): TFdDbLookup {
  return async (objPath: string) => {
    const { name, schema } = splitObjPath(objPath);
    for (const kind of DB_KINDS) {
      let probe: TProbe;
      try {
        probe = await probeDefinition(mcp, connection, name, schema, kind);
      } catch {
        return { exists: null, kind: null }; // сбой соединения/доступа
      }
      if (probe === 'notfound') continue;
      if (probe === 'okfalse') return { exists: null, kind: null }; // сбой JSON, не «нет»
      return { exists: true, kind };
    }
    return { exists: false, kind: null };
  };
}

export function makeGetDefinition(mcp: TFdMcpClient, connection: string): TFdGetDefinition {
  return async (objPath: string) => {
    const { name, schema } = splitObjPath(objPath);
    for (const kind of DB_KINDS) {
      let probe: TProbe;
      try {
        probe = await probeDefinition(mcp, connection, name, schema, kind);
      } catch (e) {
        throw e; // сбой сети/прав пробрасываем наружу
      }
      if (probe === 'notfound') continue;
      if (probe === 'okfalse') {
        throw new Error(`get_definition: ${objPath}: ok:false (сбой, не «объекта нет»)`);
      }
      const definition = probe.definitions[0].definition;
      if (definition === undefined || definition.trim() === '') {
        throw new Error(`get_definition: ${objPath}: пустое определение`);
      }
      return definition;
    }
    throw new Error(`объект ${objPath} не найден (ни procedure/function/view)`);
  };
}

/** Снять определения для снапшота через движок (`collectSnapshot` с onError):
 * объект отсутствует → «объекта нет в БД»; сбой MCP → отдельная ошибка с текстом.
 * Прогон не роняем. Различение not_found/сбой — по контракту vv-db-mcp. */
export function snapshotDefinitions(
  objects: TFdDbObject[],
  getDefinition: TFdGetDefinition,
  errors: string[],
): Promise<Array<{ objPath: string; definition: string }>> {
  return collectSnapshot(objects, getDefinition, {
    onError: (objPath, e) => {
      errors.push(
        isNotFoundError(e)
          ? `snapshot: ${objPath}: объекта нет в БД`
          : `snapshot: ${objPath}: ${String((e as Error)?.message ?? e)}`,
      );
    },
  });
}

function roleTools(spec: TFdSpecConfig, role: string, mcp?: TFdMcpClient): TFdMcpTool[] | undefined {
  if (mcp === undefined) return undefined;
  const names = resolveRole(spec, role).tools;
  if (names === undefined || names.length === 0) return undefined;
  return mcp.tools.filter((t) => names.includes(t.name));
}

/**
 * Валидация «кандидата-инструмента» против allowlist роли — единая точка и для
 * обычного прогона, и для dry-run (тот же вердикт, меняется только исполнение).
 */
export function toolCallVerdict(
  name: string,
  allowed: ReadonlySet<string>,
  dryRun: boolean,
): 'execute' | 'skip' | 'forbid' {
  if (!allowed.has(name)) return 'forbid';
  if (dryRun && name === 'execute_sql') return 'skip';
  return 'execute';
}

/** По завершении таска (DONE) собрать заметки-кандидаты в vault (человек мержит руками). */
async function generateKnowledgeCandidates(
  spec: TFdSpecConfig,
  providers: TFdProvidersConfig,
  taskDir: string,
  journal: string,
): Promise<void> {
  const brief = roleBrief(spec, 'AI.ANALYST', textToStructure(journal, true));
  const model = brief.spec.model;
  if (model === undefined) return; // роль не настроена — пропускаем
  const provider = resolveProvider(providers, model);
  if (provider === null) return;
  const system = [
    'Ты — AI.ANALYST в методологии flowdini.',
    'По журналу таска собери заметки-кандидаты для долгосрочной базы знаний (vault): факты, решения, тонкости домена и причины решений, которые стоит сохранить отдельно от кода.',
    'Формат: каждая заметка — заголовок `## {тема}` и 1–4 строки текста. Без вступлений. Если сохранять нечего — верни ровно `(пусто)`.',
  ].join('\n');
  const user = `Журнал таска (chat.md):\n---\n${journal}\n---`;
  const text = await runRole({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, system, user });
  const trimmed = text.trim();
  const target = join(taskDir, 'knowledge-candidates.md');
  const tmp = `${target}.tmp`;
  await writeFile(tmp, trimmed === '(пусто)' ? '' : trimmed + '\n');
  await rename(tmp, target);
}

export async function run(opts: TFdRunOptions): Promise<TFdRunResult> {
  const chatPath = join(opts.taskDir, CHAT_FILE);
  const vaultRoot = opts.vaultRoot ?? opts.taskDir;
  const connection = opts.connection ?? 'mssql';
  const maxSteps = opts.maxSteps ?? 20;
  const fixMode = opts.spec.fixMode ?? 'item';
  const result: TFdRunResult = { steps: 0, stoppedFor: null, errors: [], warnings: [], hitMaxSteps: false, drySections: [], dryWarnings: [] };

  let journal = await readFile(chatPath, 'utf8');
  let content = textToStructure(journal, true);

  for (let i = 0; i < maxSteps; i++) {
    const step = nextStep(content);
    if (step === null) {
      // Движок останавливает на CRASH так же, как на DONE; здесь различаем причину.
      if (isCrashed(content)) {
        result.errors.push('журнал содержит # CRASH — разбери, исправь, удали раздел и перезапусти');
      }
      break;
    }
    const addressedRole = step.roles[0];
    if (roleCovers('HUMAN', addressedRole)) {
      result.stoppedFor = addressedRole;
      break;
    }
    // Канон: код пишет JUNIOR, правки — SENIOR (INSTANCE наследует FUNC, если не задан в SPEC).
    const role = step.section === 'CODE' ? 'AI.CODER.JUNIOR'
      : step.section === 'FIX' ? 'AI.CODER.SENIOR'
      : addressedRole;
    const brief = roleBrief(opts.spec, role, content);
    const model = brief.spec.model;
    if (model === undefined) {
      result.errors.push(`роль ${role}: не задан model в SPEC`);
      break;
    }
    const provider = resolveProvider(opts.providers, model);
    if (provider === null) {
      result.errors.push(`роль ${role}: модель ${model} не закреплена ни за одним провайдером`);
      break;
    }
    const gate = step.section === 'REVIEW' && gateDue(content, opts.spec);
    const system = await buildSystemPrompt(role, brief.spec, brief.context, brief.vault, vaultRoot, gate, opts.mcp !== undefined ? connection : null);
    const l1Number = nextL1Number(content, step.section ?? 'ISSUE');
    const reference =
      step.section === 'FIX' && fixMode === 'item' && opts.spec.fixReference === true
        ? fixReference(content, step.arc.addr)
        : undefined;
    // Accept-политика: детерминированный accept-статус дуги-ответа человека
    // (`ANSWERS n#A m`). `null` (не ответ человека) → undefined в opts.
    const acceptAnswer =
      step.section === null ? acceptOf(content, step.arc.addr) : null;
    const user = buildUserPrompt(role, journal, step.section, step.arc.addr, l1Number, {
      fixMode,
      fixReference: reference,
      acceptAnswer: acceptAnswer ?? undefined,
    });
    const tools = roleTools(opts.spec, role, opts.mcp);
    const allowedTools = new Set((tools ?? []).map((t) => t.name));
    // budget.maxTurns (SPEC) — лимит tool-calling ходов на шаг роли; иначе 8 (по умолчанию).
    const budgetTurns = brief.spec.budget?.maxTurns;
    const maxTurns = typeof budgetTurns === 'number' && Number.isInteger(budgetTurns) && budgetTurns >= 1 ? budgetTurns : undefined;
    const callTool = opts.mcp !== undefined
      ? async (n: string, a: Record<string, unknown>) => {
          // Защита: агент может вызвать только инструменты своей роли (SPEC tools).
          const verdict = toolCallVerdict(n, allowedTools, opts.dryRun === true);
          if (verdict === 'forbid') {
            if (opts.dryRun) {
              // dry-run: не бросаем (иначе catch запишет CRASH в журнал), а фиксируем
              // недозволенный вызов для вывода и даём агенту дописать раздел.
              result.dryWarnings.push(`${n} (роль ${role})`);
              return JSON.stringify({ ok: false, forbidden: true, note: `инструмент ${n} не разрешён роли ${role}` });
            }
            // Недозволенный вызов в обычном прогоне: оставляем след + сообщаем агенту.
            result.warnings.push(`${n} (роль ${role})`);
            throw new Error(`инструмент ${n} не разрешён роли ${role}`);
          }
          if (verdict === 'skip') {
            return JSON.stringify({ ok: true, skipped: true, note: 'dry-run: БД не изменялась' });
          }
          return opts.mcp!.call(n, a);
        }
      : undefined;

    // Пре-проверка плана кодера (OBJECT в issue-app.md): create ⇒ объекта ещё нет,
    // edit ⇒ есть, тип в БД совпадает. Только при ПЕРВОМ входе кодера (в журнале ещё
    // нет CODE): после CODE объекты уже созданы, повторная сверка даст ложное «already exists».
    if (step.section === 'CODE' && opts.mcp !== undefined) {
      if (!level1List(content).some((l) => l.title === 'CODE')) {
        const plan = await collectTaskObjects(opts.taskDir);
        // Сначала сверка плана с БД: провал — стоп, ничего не пишем (в т.ч. baseline),
        // чтобы после исправления плана baseline переснялся по-новому.
        const valErrs = await validateDbObject(plan, makeLookup(opts.mcp, connection));
        if (valErrs.length > 0) {
          result.errors.push(...valErrs.map((e) => `${e.objPath}: ${e.error}`));
          break;
        }
        // Baseline «до всех изменений»: один раз, при первом входе кодера (план уже
        // зафиксирован в issue-app.md и прошёл сверку). Для create-объектов список
        // пуст (= «до» ничего не было). В dry-run не пишем.
        if (!opts.dryRun) {
          const baselineManifest = await readIfExists(join(opts.taskDir, 'snapshots', 'baseline', 'manifest.json'));
          if (baselineManifest === null) {
            const existing: TFdDbObject[] = [];
            for (const o of plan) {
              const l = await makeLookup(opts.mcp, connection)(o.objPath);
              if (l.exists === true) existing.push(o);
              else if (l.exists === null) result.errors.push(`baseline: cannot verify ${o.objPath}`);
            }
            const defs = await snapshotDefinitions(existing, makeGetDefinition(opts.mcp, connection), result.errors);
            await captureSnapshot(opts.taskDir, 'baseline', defs);
          }
        }
      }
    }

    let sectionText: string;
    try {
      sectionText = await runRole({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model,
        system,
        user,
        tools,
        callTool,
        maxTurns,
      });
    } catch (err) {
      const msg = `${role}: ${err instanceof Error ? err.message : String(err)}`;
      if (opts.dryRun) {
        // dry-run не пишет журнал: сбой роли фиксируем в dryWarnings, не в # CRASH.
        result.dryWarnings.push(msg);
        break;
      }
      const tmpPath = `${chatPath}.tmp`;
      await writeFile(tmpPath, `${journal.trimEnd()}\n\n${buildCrash([msg])}\n`);
      await rename(tmpPath, chatPath);
      result.errors.push(msg);
      break;
    }

    // Хост проставляет L1-заголовок (и свойства для CODE), затем перезаписывает
    // детерминированные fd-from/fd-createdAt на топиках LLM (подзаголовки REVIEW/FIX
    // и L1+подзаголовки в null-кейсе). CODE — только тело без заголовков: пост-обработку
    // пропускаем, чтобы не трогать тело (в т.ч. fenced SQL). Единый `now` на весь раздел.
    const stepNow = new Date();
    const now = () => stepNow;
    let entry: string;
    if (step.section === 'FIX' && fixMode === 'item') {
      entry = stampFixItem(sectionText.trim(), role, l1Number, step.arc.addr, now);
    } else if (step.section === 'CODE') {
      entry = `${stampHeader('CODE', role, l1Number, step.arc.addr, now)}${sectionText.trim()}`;
    } else {
      entry = `${stampHeader(step.section, role, l1Number, step.arc.addr, now)}${stampRoleFields(sectionText, role, now).trim()}`;
    }

    // dry-run: раздел не пишем в журнал — отдаём текстом наружу и выходим.
    if (opts.dryRun) {
      result.drySections.push(entry.trim());
      break;
    }

    const candidate = `${journal.trimEnd()}\n\n${entry.trim()}\n`;
    // Атомарная запись: tmp + rename — журнал никогда не остаётся полузаписанным.
    const tmpPath = `${chatPath}.tmp`;
    await writeFile(tmpPath, candidate);
    await rename(tmpPath, chatPath);
    content = textToStructure(candidate, true);
    result.steps++;

    let errs: Array<{ relativeFileName: string; error: string }>;
    try {
      errs = await taskCheck(opts.taskDir, { exclude: ['issue-draft.md', 'issue-dom.md', 'knowledge-candidates.md'], vaultRoot });
    } catch (e) {
      errs = [{ relativeFileName: CHAT_FILE, error: `taskCheck failed: ${String((e as Error)?.message ?? e)}` }];
    }
    if (errs.length > 0) {
      // Битый раздел не оставляем: откат к состоянию ДО ответа роли + # CRASH.
      const crashBody = buildCrash(errs.map((e) => `${e.relativeFileName}: ${e.error}`), sectionText);
      await writeFile(tmpPath, `${journal.trimEnd()}\n\n${crashBody}\n`);
      await rename(tmpPath, chatPath);
      result.errors = errs.map((e) => `${e.relativeFileName}: ${e.error}`);
      break;
    }
    journal = candidate;

    // Снапшот после CODE/FIX: определения объектов → captureSnapshot.
    if (step.section === 'CODE' || step.section === 'FIX') {
      if (opts.mcp !== undefined) {
        const defs = await snapshotDefinitions(await collectTaskObjects(opts.taskDir), makeGetDefinition(opts.mcp, connection), result.errors);
        const iteration = level1List(content).filter((l) => l.title === 'CODE' || l.title === 'FIX').length;
        await captureSnapshot(opts.taskDir, iteration, defs);
      }
    }
  }
  if (result.errors.length === 0 && result.stoppedFor === null && result.steps >= maxSteps && nextStep(content) !== null) {
    result.hitMaxSteps = true;
  }
  // Завершённый таск (последний L1 — DONE) → кандидаты в vault. Генерация только один
  // раз (если файла ещё нет); ошибка генерации не роняет прогон.
  const l1s = level1List(content);
  if (!opts.dryRun && l1s.length > 0 && l1s[l1s.length - 1].title === 'DONE') {
    if ((await readIfExists(join(opts.taskDir, 'knowledge-candidates.md'))) === null) {
      try {
        await generateKnowledgeCandidates(opts.spec, opts.providers, opts.taskDir, journal);
      } catch {
        // пропускаем: knowledge-candidates — не критично для результата таска
      }
    }
  }
  return result;
}
