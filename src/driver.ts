// Драйвер цикла исполнения: nextStep → roleBrief → агент-роль (LLM + MCP) → раздел → taskCheck → снапшот.
import { readFile, writeFile, readdir, rename, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { textToStructure, HEADING_RE, openFence, isClosingFence } from 'flowdini-spec';
import type { TFdContent } from 'flowdini-spec';
import {
  contentPretty,
  nextStep,
  openArcs,
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
  if (max >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`nextL1Number: номер раздела «${title}» достиг MAX_SAFE_INTEGER — журнал не может расти дальше`);
  }
  return max + 1;
}

/** Null-кейс (аналитик сам пишет раздел): модель пишет `# ISSUE`/`# QUESTIONS`
 *  БЕЗ номера — номер проставляет хост, не модель (иначе парсер даст `idx: 0` и
 *  taskCheck отвергнет раздел как «заголовок без номера»). R13: пере-нумеруем и
 *  голые, и УЖЕ пронумерованные заголовки (`# ISSUE 3` → корректный номер), чтобы
 *  «с номером» из вывода модели не расходился с промптом «БЕЗ номера» и не давал
 *  коллизий; несколько одноимённых L1 получают РАЗНЫЕ последовательные номера;
 *  строки-примеры внутри fence не трогаем (грамматика spec: `openFence`/`isClosingFence`). */
export function numberL1Headers(text: string, content: TFdContent): string {
  const counters = new Map<string, number>();
  let fenceChar: string | null = null;
  let fenceLen = 0;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (fenceChar === null) {
      const open = openFence(line);
      if (open !== null) {
        fenceChar = open.char;
        fenceLen = open.len;
        out.push(line);
        continue;
      }
      const h = HEADING_RE.exec(line);
      if (h !== null && h[1].length === 1) {
        const raw = (h[2] ?? '').trim();
        const sp = raw.indexOf(' ');
        const title = sp === -1 ? raw : raw.slice(0, sp);
        if (title === 'ISSUE' || title === 'QUESTIONS') {
          const n = counters.get(title) ?? nextL1Number(content, title);
          counters.set(title, n + 1);
          out.push(`# ${title} ${n}`);
          continue;
        }
      }
      out.push(line);
    } else {
      if (isClosingFence(line, fenceChar, fenceLen)) {
        fenceChar = null;
        fenceLen = 0;
      }
      out.push(line);
    }
  }
  return out.join('\n');
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** R7: текст определений последнего post-change снимка (наибольшая числовая итерация
 *  в `snapshots/`, `baseline` не считается). Порядок файлов детерминирован (сортировка),
 *  каждый объект — блоком `### <file>` + текст. Нет снимков — `null`. Сбой чтения одного
 *  файла не роняет прогон (снимок — контекст ревью, не обязательный материал). */
export async function readLatestSnapshot(taskDir: string): Promise<string | null> {
  const snapsDir = join(taskDir, 'snapshots');
  const entries = await readdir(snapsDir, { withFileTypes: true }).catch(() => []);
  let latest = -1;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const n = Number(e.name);
    if (Number.isInteger(n) && n >= 1 && n > latest) latest = n;
  }
  if (latest < 1) return null;
  const dir = join(snapsDir, String(latest));
  const files = (await readdir(dir).catch(() => [])).sort();
  const parts: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.sql')) continue;
    const text = await readIfExists(join(dir, f));
    if (text !== null) parts.push(`### ${f}`, text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** R4: заканчивается ли текст незакрытым fence (``` или ~~~). Такой журнал битый:
 *  дописанный далее раздел (включая `# CRASH`) попал бы внутрь fence и не распарсился. */
export function hasOpenFence(text: string): boolean {
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of text.split('\n')) {
    if (fenceChar === null) {
      const open = openFence(line);
      if (open !== null) {
        fenceChar = open.char;
        fenceLen = open.len;
      }
    } else if (isClosingFence(line, fenceChar, fenceLen)) {
      fenceChar = null;
      fenceLen = 0;
    }
  }
  return fenceChar !== null;
}

// Все OBJECT-объекты таска: живут ТОЛЬКО в issue-app.md (план), а НЕ в chat.md.
// result-app.md — отчёт о результате, не план: его OBJECT не участвуют в сверке БД
// и в снапшотах (иначе create/edit одного obj-path конфликтуют между файлами).
// Рекурсивный обход taskDir (vault может быть вложен); дедуп по obj-path;
// обход детерминированный (сортировка по имени), snapshots/ и скрытые каталоги пропускаем.
export async function collectTaskObjects(taskDir: string): Promise<TFdDbObject[]> {
  const seen = new Set<string>();
  const objects: TFdDbObject[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'snapshots' || e.name.startsWith('.')) continue;
        await walk(p);
      } else if (e.isFile() && e.name === 'issue-app.md') {
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
  // R7: обязательный минимум контекста роли — fail-closed. Отсутствующий/нечитаемый
  // файл не молча пропускается, а останавливает ход: иначе роль работает без
  // контрактов безопасности/карты схемы, которые ей обязаны передать.
  for (const f of context) {
    const p = resolve(vaultRoot, f);
    const text = await readIfExists(p);
    if (text === null) {
      throw new Error(`SPEC context «${f}» не читается (${p}): обязательный минимум контекста роли ${role} недоступен`);
    }
    lines.push(`Контекст из «${f}»:`);
    lines.push('```');
    lines.push(text);
    lines.push('```');
    lines.push('');
  }
  // fd-vault (пользовательский ввод из ISSUE) — не выпускаем за vaultRoot (path traversal, симлинки).
  const vaultReal = await realpath(vaultRoot).catch(() => null);
  for (const f of vault) {
    const p = resolve(vaultRoot, f);
    if (vaultReal === null) continue; // vaultRoot не резолвится — vault недоступен, файл не читаем (fail-closed)
    const rp = await realpath(p).catch(() => null);
    if (rp === null) continue; // файла нет
    if (rp !== vaultReal && !rp.startsWith(vaultReal + sep)) continue; // вне vault
    const text = await readIfExists(rp);
    if (text !== null) {
      lines.push(`Контекст из «${f}»:`);
      lines.push('```');
      lines.push(text);
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('Правила формата раздела (строго):');
  lines.push('1. Заголовок L1: `# {РАЗДЕЛ} {N}` (с номером). НО если хост не сообщил тебе конкретный раздел и номер (свободный ход), пиши заголовок БЕЗ номера — `# {РАЗДЕЛ}`; корректный номер проставит хост.');
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
 *    ВСЕ открытые дуги CODE/FIX → AI.REVIEWER списком `fd-reply`; подзаголовки
 *    `## BUG/RISK/OTHER` — отдельно);
 *  - `FIX` — заголовок-контейнер без свойств (свойства на вложенных `##`);
 *  - `null` (аналитик сам решает) — пусто: хост не знает раздела, LLM пишет всё.
 *  `now` — источник времени (инъекция для тестов). */
export function stampHeader(
  section: string | null,
  role: string,
  l1Number: number,
  arcAddrs: string[],
  now: () => Date = () => new Date(),
): string {
  if (section === null) return '';
  const head = `# ${section} ${l1Number}`;
  const replies = arcAddrs.map((a) => `[[#${a}]]`).join(' ');
  if (section === 'CODE') {
    return `${head}\n[fd-from:: ${role}] [fd-createdAt:: ${nowStamp(now)}] [fd-to:: AI.REVIEWER] [fd-reply:: ${replies}]\n\n`;
  }
  if (section === 'REVIEW') {
    // REVIEW закрывает ВСЕ дуги CODE/FIX → AI.REVIEWER детерминированно (fd-from + fd-reply):
    // иначе «замечаний нет» оставляет дугу открытой и nextStep зацикливает REVIEW; а
    // item-FIX (N разделов) порождал бы N микро-REVIEW и ранний гейт reviewLimit.
    return `${head}\n[fd-from:: ${role}] [fd-createdAt:: ${nowStamp(now)}] [fd-reply:: ${replies}]\n\n`;
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
    // R10: L1-дуга без подзаголовка — полный ответ прямо в FIX-контейнер (с fd-reply),
    // иначе входная дуга останется открытой и тот же FIX повторится следующим шагом.
    const props = `[fd-from:: ${role}] [fd-createdAt:: ${nowStamp(now)}] [fd-to:: AI.REVIEWER] [fd-reply:: [[#${arcAddr}]]]`;
    inner = `${props}\n\n${body.trim()}`;
  }
  return `${stampHeader('FIX', role, l1Number, [arcAddr], now)}${inner}`;
}

/** Длина тильда-fence для CRASH: строго длиннее любой серии `~` в ограждаемом
 *  тексте — иначе `~~~` (или длиннее) внутри ответа модели преждевременно закроет
 *  внешнюю ограду и часть сырого ответа снова попадёт в индексацию журнала. */
function crashFence(...parts: string[]): string {
  let maxRun = 0;
  for (const p of parts) {
    for (const m of p.matchAll(/~+/g)) {
      if (m[0].length > maxRun) maxRun = m[0].length;
    }
  }
  return '~'.repeat(Math.max(3, maxRun + 1));
}

/** Терминальный маркер аварии `# CRASH 1` (без свойств, хост не притворяется ролью):
 *  ошибки + сырой ответ AI. Обе части — в тильда-fence адаптивной длины: `taskCheck`
 *  не проверяет ссылки внутри fence (`stripFences`), а `~` не конфликтует с ```-блоками
 *  SQL, которые AI пишет в CODE/FIX. */
export function buildCrash(errors: string[], rawAnswer?: string): string {
  const out = [
    '# CRASH 1',
    '',
    'Процесс остановлен из-за непредвиденной ошибки. Разбери, исправь, удали этот раздел и перезапусти.',
  ];
  const body = rawAnswer !== undefined && rawAnswer.trim() !== '' ? rawAnswer.trimEnd() : '';
  const fence = crashFence(...errors, body);
  if (errors.length > 0) {
    out.push('', 'Ошибки:', '', fence, ...errors, fence);
  }
  if (body !== '') {
    out.push('', 'Ответ AI, породивший ошибки:', '', fence, body, fence);
  }
  return out.join('\n');
}

/** Убрать L1-заголовки (`# …`) из ответа модели вне ```/~~~ fence. Для non-null секций
 *  (CODE/REVIEW/FIX) L1 проставляет хост: `# ISSUE 7` в теле модели — инъекция, которая
 *  иначе стала бы настоящим топиком и открыла дуги. Грамматика — та же, что в spec
 *  (`HEADING_RE`/`openFence`/`isClosingFence`): заголовок = 0–3 пробела + `#` (один),
 *  fence открывается/закрывается по символу И длине маркера. `##`/`###` оставляем
 *  (их в REVIEW/bulk-FIX пишет сама модель; в CODE/item-FIX ловит `hasHeadings`). */
export function stripL1Headers(text: string): string {
  const lines = text.split('\n');
  let fenceChar: string | null = null;
  let fenceLen = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (fenceChar === null) {
      const open = openFence(line);
      if (open !== null) {
        fenceChar = open.char;
        fenceLen = open.len;
        out.push(line);
        continue;
      }
      const h = HEADING_RE.exec(line);
      if (h !== null && h[1].length === 1) {
        out.push('');
        continue;
      }
      out.push(line);
    } else {
      if (isClosingFence(line, fenceChar, fenceLen)) {
        fenceChar = null;
        fenceLen = 0;
      }
      out.push(line);
    }
  }
  return out.join('\n');
}

/** Остался ли заголовок любого уровня (`#`/`##`/`###`) вне fence. Для CODE и item-FIX
 *  тела заголовков быть не должно: их проставляет хост, а L2/L3 из прозы модели стали
 *  бы подтопиками и подделали маршрут дуг. */
export function hasHeadings(text: string): boolean {
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of text.split('\n')) {
    if (fenceChar === null) {
      const open = openFence(line);
      if (open !== null) {
        fenceChar = open.char;
        fenceLen = open.len;
        continue;
      }
      if (HEADING_RE.test(line)) return true;
    } else if (isClosingFence(line, fenceChar, fenceLen)) {
      fenceChar = null;
      fenceLen = 0;
    }
  }
  return false;
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
  /** R7: текст актуального post-change снимка БД — контекст для REVIEW. */
  snapshotText?: string;
  /** R9: адреса дуг, которые закрывает заголовок REVIEW (все, что ревьюер обязан проверить). */
  reviewAddrs?: string[];
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
    lines.push(`Следующий ход: роль «${role}» отвечает на ВСЕ открытые замечания ревью «${arcAddr.split('#')[0]}» сразу (одна секция на все замечания), а не на одну дугу.`);
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
      if (opts?.reviewAddrs !== undefined && opts.reviewAddrs.length > 1) {
        lines.push(`Этот REVIEW закрывает несколько дуг к ревьюеру. Проверь ВСЕ входные объекты по этим дугам (${opts.reviewAddrs.map((a) => '«' + a + '»').join(', ')}) — замечания можно группировать, но ни одна дуга не должна остаться без вердикта.`);
      }
      if (opts?.snapshotText !== undefined && opts.snapshotText.trim() !== '') {
        lines.push('');
        lines.push('Актуальный снимок БД (post-change, после последних CODE/FIX) — ревьюируй именно его содержимое:');
        lines.push('---');
        lines.push(opts.snapshotText);
        lines.push('---');
      }
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
    lines.push('Раздел выбери сам (ISSUE → QUESTIONS или передача ISSUE дальше). Пиши заголовок раздела БЕЗ номера (номер проставит хост) и свойства fd-to/fd-reply (на дугу); поля fd-from/fd-createdAt НЕ пиши — их проставляет хост.');
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

/** obj-path: `schema.name` или `db.schema.name` — БД задаёт `connection`, берём последние
 *  две части (schema, name). Префикс из 1+ сегментов (имя БД) обязан совпадать с
 *  `connection`: иначе объект адресован не в ту базу. */
function splitObjPath(objPath: string): { name: string; schema: string | undefined; dbPrefix: string | undefined } {
  const parts = objPath.split('.');
  return {
    name: parts[parts.length - 1],
    schema: parts.length >= 2 ? parts[parts.length - 2] : undefined,
    dbPrefix: parts.length >= 3 ? parts.slice(0, parts.length - 2).join('.') : undefined,
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
  // `ok:true` без массива `definitions` — нарушение протокола, а не «объекта нет».
  if (!Array.isArray(parsed.definitions)) return 'okfalse';
  if (parsed.definitions.length === 0) return 'notfound';
  return { definitions: parsed.definitions };
}

export function makeLookup(mcp: TFdMcpClient, connection: string): TFdDbLookup {
  return async (objPath: string) => {
    const { name, schema, dbPrefix } = splitObjPath(objPath);
    if (dbPrefix !== undefined && dbPrefix !== connection) {
      return { exists: null, kind: null, reason: `obj-path ${objPath}: база "${dbPrefix}" не совпадает с connection "${connection}"` };
    }
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
    const { name, schema, dbPrefix } = splitObjPath(objPath);
    if (dbPrefix !== undefined && dbPrefix !== connection) {
      throw new Error(`obj-path ${objPath}: база "${dbPrefix}" не совпадает с connection "${connection}"`);
    }
    for (const kind of DB_KINDS) {
      const probe = await probeDefinition(mcp, connection, name, schema, kind);
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
  const names = resolveRole(spec, role).tools;
  if (names === undefined || names.length === 0) return undefined;
  if (mcp === undefined) {
    throw new Error(`роль ${role} требует инструменты ${names.join(', ')}, но MCP-клиент не задан`);
  }
  const available = new Set(mcp.tools.map((t) => t.name));
  const missing = names.filter((n) => !available.has(n));
  if (missing.length > 0) {
    throw new Error(`роль ${role}: инструменты недоступны у MCP: ${missing.join(', ')}`);
  }
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
  // `run()` — публичный API: лимит шагов обязан быть целым >= 1, иначе цикл ведёт
  // себя недетерминированно (дробный maxSteps даёт лишний проход).
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`maxSteps должен быть целым >= 1, получено ${JSON.stringify(maxSteps)}`);
  }
  const fixMode = opts.spec.fixMode ?? 'item';
  const result: TFdRunResult = { steps: 0, stoppedFor: null, errors: [], warnings: [], hitMaxSteps: false, drySections: [], dryWarnings: [] };

  let journal = await readFile(chatPath, 'utf8');
  let content = textToStructure(journal, true);

  // C4: пред-проверка исходного состояния — не начинаем писать поверх уже битого
  // журнала (объектная часть issue-app.md и структура chat.md проверяются до агента).
  let initialErrs: Array<{ relativeFileName: string; error: string }>;
  try {
    initialErrs = await taskCheck(opts.taskDir, { exclude: ['issue-draft.md', 'issue-dom.md', 'knowledge-candidates.md'], vaultRoot });
  } catch (e) {
    initialErrs = [{ relativeFileName: CHAT_FILE, error: `taskCheck failed: ${String((e as Error)?.message ?? e)}` }];
  }
  if (initialErrs.length > 0) {
    result.errors.push(...initialErrs.map((e) => `${e.relativeFileName}: ${e.error}`));
    return result;
  }
  // R4: незакрытый fence в конце журнала — битое состояние: следующий раздел (включая
  // `# CRASH`) попал бы внутрь fence и не распарсился. Стоп до агента.
  if (hasOpenFence(journal)) {
    result.errors.push('журнал заканчивается незакрытым fence — закрой его и перезапусти');
    return result;
  }

  for (let i = 0; i < maxSteps; i++) {
    const step = nextStep(content);
    if (step === null) {
      // Движок останавливает на CRASH так же, как на DONE; здесь различаем причину.
      if (isCrashed(content)) {
        result.errors.push('журнал содержит # CRASH — разбери, исправь, удали раздел и перезапусти');
      }
      break;
    }
    const addressedRole = step.arc.to[0];
    if (roleCovers('HUMAN', addressedRole)) {
      result.stoppedFor = addressedRole;
      break;
    }
    // Канон: код пишет JUNIOR, правки — SENIOR (INSTANCE наследует FUNC, если не задан в SPEC).
    const role = step.section === 'CODE' ? 'AI.CODER.JUNIOR'
      : step.section === 'FIX' ? 'AI.CODER.SENIOR'
      : addressedRole;
    // Исполнитель обязан покрывать адресата дуги — иначе ответ не закроет дугу и цикл
    // упрётся в maxSteps. Секции CODE/FIX назначают JUNIOR/SENIOR: если ISSUE адресован
    // конкретному INSTANCE (напр. AI.CODER.SENIOR), которого исполнитель не покрывает, —
    // детерминированный стоп с подсказкой, а не тихий цикл.
    if (!roleCovers(addressedRole, role)) {
      result.errors.push(
        `роль ${role} не покрывает адресата дуги ${addressedRole}: адресуйте ISSUE роли, которую покрывает исполнитель (${step.section ?? 'свободный раздел'})`,
      );
      break;
    }
    // Единые часы на весь шаг: фикс-справка и штампы используют один `now` (детерминизм).
    const stepNow = new Date();
    const now = () => stepNow;
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
    let system: string;
    try {
      system = await buildSystemPrompt(role, brief.spec, brief.context, brief.vault, vaultRoot, gate, opts.mcp !== undefined ? connection : null);
    } catch (e) {
      result.errors.push(String((e as Error)?.message ?? e));
      break;
    }
    const l1Number = nextL1Number(content, step.section ?? 'ISSUE');
    const reference =
      step.section === 'FIX' && fixMode === 'item' && opts.spec.fixReference === true
        ? fixReference(content, step.arc.addr, now)
        : undefined;
    // Accept-политика: детерминированный accept-статус дуги-ответа человека
    // (`ANSWERS n#A m`). Применяется только на маршруте аналитика (ANSWERS адресован
    // AI.ANALYST): иначе accept-разбор не валиден. `null` (не ответ человека) → undefined.
    const acceptAnswer =
      step.section === null && roleCovers('AI.ANALYST', role)
        ? acceptOf(content, step.arc.addr)
        : null;
    // R9: заголовок REVIEW закрывает только открытые дуги CODE/FIX, адресованные
    // ТЕКУЩЕМУ исполнителю (roleCovers), а не всё семейство AI.REVIEWER — иначе сюда
    // попали бы не-CODE/FIX дуги и дуги к другому экземпляру ревьюера, которые этот
    // автор не закроет. R7: REVIEW дополнительно получает актуальный post-change снимок.
    const reviewAddrs =
      step.section === 'REVIEW'
        ? openArcs(content)
            .filter(
              (a) =>
                (a.addr.startsWith('CODE ') || a.addr.startsWith('FIX ')) &&
                a.to.some((r) => roleCovers(role, r)),
            )
            .map((a) => a.addr)
        : [step.arc.addr];
    const snapshotText = step.section === 'REVIEW' ? await readLatestSnapshot(opts.taskDir) : undefined;
    const user = buildUserPrompt(role, journal, step.section, step.arc.addr, l1Number, {
      fixMode,
      fixReference: reference,
      acceptAnswer: acceptAnswer ?? undefined,
      snapshotText: snapshotText ?? undefined,
      reviewAddrs: step.section === 'REVIEW' ? reviewAddrs : undefined,
    });
    let tools: TFdMcpTool[] | undefined;
    try {
      tools = roleTools(opts.spec, role, opts.mcp);
    } catch (e) {
      result.errors.push(String((e as Error)?.message ?? e));
      break;
    }
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
            // C5: ошибки baseline собираем отдельно — манифест пишем только при полном
            // снимке, иначе следующий запуск сочтёт неполный baseline готовым и не доснимет.
            const baselineErrors: string[] = [];
            const existing: TFdDbObject[] = [];
            for (const o of plan) {
              const l = await makeLookup(opts.mcp, connection)(o.objPath);
              if (l.exists === true) existing.push(o);
              else if (l.exists === null) baselineErrors.push(`baseline: cannot verify ${o.objPath}`);
            }
            const defs = await snapshotDefinitions(existing, makeGetDefinition(opts.mcp, connection), baselineErrors);
            if (baselineErrors.length > 0) {
              result.errors.push(...baselineErrors);
              break;
            }
            await captureSnapshot(opts.taskDir, 'baseline', defs);
          } else {
            // R17: baseline уже снят — проверить его актуальность относительно плана.
            // План мог измениться после снятия (объект удалён/добавлен/стал edit), а guard
            // «до первого CODE» не переснимет: расхождение стопит, человек удаляет
            // snapshots/baseline/ и перезапускает.
            let manifest: { objects?: Array<{ objPath?: string }> };
            try {
              manifest = JSON.parse(baselineManifest) as { objects?: Array<{ objPath?: string }> };
            } catch {
              result.errors.push('baseline manifest.json не читается — удалите snapshots/baseline/ и перезапустите');
              break;
            }
            const manifestPaths = new Set((manifest.objects ?? []).map((o) => o.objPath).filter((p) => p !== undefined && p.trim() !== '') as string[]);
            const planPaths = new Set(plan.map((o) => o.objPath));
            const stale = [...manifestPaths].filter((p) => !planPaths.has(p));
            const missing = plan.filter((o) => o.objAction === 'edit' && !manifestPaths.has(o.objPath)).map((o) => o.objPath);
            if (stale.length > 0 || missing.length > 0) {
              result.errors.push(
                `baseline устарел относительно плана (в baseline, но не в плане: ${stale.join(', ') || '—'}; edit без baseline: ${missing.join(', ') || '—'}) — удалите snapshots/baseline/ и перезапустите`,
              );
              break;
            }
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
        // dry-run не пишет журнал (# CRASH не уместен), но сбой роли — ошибка:
        // прогон не завершился штатно, exit-код должен быть ненулевым.
        result.errors.push(msg);
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
    // пропускаем, чтобы не трогать тело (в т.ч. fenced SQL).
    // C3: для non-null секций срезаем L1-заголовки из ответа модели (вне fence) — хост
    // ставит L1 сам, `# ISSUE 7` в теле модели не должен стать топиком. Null-кейс модель
    // пишет L1 сама — не трогаем.
    const sanitized = step.section !== null ? stripL1Headers(sectionText) : numberL1Headers(sectionText, content);
    // reviewAddrs вычислен выше (до промпта, R9): REVIEW закрывает все совместимые
    // открытые дуги CODE/FIX к текущему ревьюеру одним разделом (список fd-reply).
    let entry: string;
    if (step.section === 'FIX' && fixMode === 'item') {
      entry = stampFixItem(sanitized.trim(), role, l1Number, step.arc.addr, now);
    } else if (step.section === 'CODE') {
      entry = `${stampHeader('CODE', role, l1Number, [step.arc.addr], now)}${sanitized.trim()}`;
    } else {
      entry = `${stampHeader(step.section, role, l1Number, reviewAddrs, now)}${stampRoleFields(sanitized, role, now).trim()}`;
    }

    // dry-run: раздел не пишем в журнал — отдаём текстом наружу и выходим.
    if (opts.dryRun) {
      result.drySections.push(entry.trim());
      break;
    }

    const candidate = `${journal.trimEnd()}\n\n${entry.trim()}\n`;
    const tmpPath = `${chatPath}.tmp`;
    // K4: валидация кандидата ДО публикации — taskCheck по содержимому chat.md-кандидата
    // (override), журнал на диске ещё не тронут. Битый раздел в журнал не попадает.
    content = textToStructure(candidate, true);
    let errs: Array<{ relativeFileName: string; error: string }> = [];
    // R4: свободный ход обязан дать РОВНО один новый L1 допустимого типа (ISSUE/QUESTIONS)
    // и закрыть входную дугу — иначе ход засчитан без нового раздела/прогресса и та же
    // дуга вернётся следующим шагом. `steps++` считает состоявшийся переход, не структуру.
    if (step.section === null) {
      const before = level1List(textToStructure(journal, true));
      const after = level1List(content);
      const added = after.filter((l) => !before.some((b) => b.title === l.title && b.idx === l.idx));
      if (added.length !== 1) {
        errs.push({ relativeFileName: CHAT_FILE, error: `свободный ход: ожидался ровно один новый L1-раздел, получено ${added.length}` });
      } else if (added[0].title !== 'ISSUE' && added[0].title !== 'QUESTIONS') {
        errs.push({ relativeFileName: CHAT_FILE, error: `свободный ход: недопустимый тип раздела «${added[0].title}» (допустимы ISSUE, QUESTIONS)` });
      }
      if (openArcs(content).some((a) => a.addr === step.arc.addr)) {
        errs.push({ relativeFileName: CHAT_FILE, error: `свободный ход: раздел не закрыл входную дугу ${step.arc.addr}` });
      }
    }
    // C3: тело CODE и item-FIX не должно содержать заголовков — их проставляет хост,
    // L2/L3 из прозы модели стали бы подтопиками и подделали маршрут дуг.
    if ((step.section === 'CODE' || (step.section === 'FIX' && fixMode === 'item')) && hasHeadings(sanitized)) {
      errs.push({ relativeFileName: CHAT_FILE, error: `тело ${step.section} не должно содержать заголовков (их проставляет хост)` });
    } else {
      try {
        errs = await taskCheck(opts.taskDir, {
          exclude: ['issue-draft.md', 'issue-dom.md', 'knowledge-candidates.md'],
          vaultRoot,
          override: { fileName: CHAT_FILE, text: candidate },
        });
      } catch (e) {
        errs = [{ relativeFileName: CHAT_FILE, error: `taskCheck failed: ${String((e as Error)?.message ?? e)}` }];
      }
    }
    // P0: при превышении reviewLimit гейт обязателен — этот REVIEW обязан начинаться
    // с `## Q` к HUMAN.CODER (taskCheck проверяет порядок/адресат, но не наличие).
    if (gate && step.section === 'REVIEW') {
      const hasGateQ = content.itemList.some(
        (it) => it.topic.level1?.title === 'REVIEW' && it.topic.level1.idx === l1Number && it.topic.level2?.title === 'Q',
      );
      if (!hasGateQ) {
        errs.push({ relativeFileName: CHAT_FILE, error: `gate due: REVIEW ${l1Number} должен начинаться с ## Q к HUMAN.CODER` });
      }
    }
    if (errs.length > 0) {
      // Битый раздел не публикуем: откат к состоянию ДО ответа роли + # CRASH.
      const crashBody = buildCrash(errs.map((e) => `${e.relativeFileName}: ${e.error}`), sectionText);
      const rolledBack = `${journal.trimEnd()}\n\n${crashBody}\n`;
      await writeFile(tmpPath, rolledBack);
      await rename(tmpPath, chatPath);
      // Не затираем ранее накопленные ошибки (baseline/snapshot) и отражаем фактическое
      // состояние диска — иначе нижний knowledge-candidates увидит DONE из отвергнутого кандидата.
      result.errors.push(...errs.map((e) => `${e.relativeFileName}: ${e.error}`));
      content = textToStructure(rolledBack, true);
      break;
    }
    // Атомарная запись: tmp + rename — журнал никогда не остаётся полузаписанным.
    await writeFile(tmpPath, candidate);
    await rename(tmpPath, chatPath);
    result.steps++;
    journal = candidate;

    // Снапшот после CODE/FIX: определения объектов → captureSnapshot.
    // F5: при неполном наборе определений манифест НЕ пишем и прогон стопим — иначе
    // частичный снимок следующий запуск сочтёт готовым и не доснимет.
    if (step.section === 'CODE' || step.section === 'FIX') {
      if (opts.mcp !== undefined) {
        const snapErrors: string[] = [];
        const defs = await snapshotDefinitions(await collectTaskObjects(opts.taskDir), makeGetDefinition(opts.mcp, connection), snapErrors);
        if (snapErrors.length > 0) {
          result.errors.push(...snapErrors);
          break;
        }
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
