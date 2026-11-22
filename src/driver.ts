// Драйвер цикла исполнения: nextStep → roleBrief → агент-роль (LLM + MCP) → раздел → taskCheck → снапшот.
import { readFile, writeFile, readdir, rename, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { textToStructure } from 'flowdini-spec';
import type { TFdContent } from 'flowdini-spec';
import {
  nextStep,
  roleBrief,
  gateDue,
  taskCheck,
  level1List,
  roleCovers,
  resolveRole,
  extractDbObjects,
  validateDbObject,
  captureSnapshot,
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
  hitMaxSteps: boolean;
  /** dry-run: тексты разделов, которые агент написал бы (не записаны в журнал). */
  drySections: string[];
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
    if (vaultReal !== null) {
      const rp = await realpath(p).catch(() => null);
      if (rp === null) continue; // файла нет
      if (rp !== vaultReal && !rp.startsWith(vaultReal + sep)) continue; // вне vault
    }
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
  lines.push('1. Заголовок: `# {РАЗДЕЛ} {N}` — имя и номер подсказаны в запросе.');
  lines.push('2. Сразу следующей строкой — свойства в ОДНУ строку: `[fd-from:: {РОЛЬ}] [fd-createdAt:: {ISO8601}] [fd-reply:: [[#{АДРЕС_ДУГИ}]]]`.');
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

export function buildUserPrompt(
  role: string,
  journal: string,
  section: string | null,
  arcAddr: string,
  l1Number: number,
): string {
  const lines: string[] = [];
  lines.push('Журнал таска (chat.md):');
  lines.push('---');
  lines.push(journal);
  lines.push('---');
  lines.push('');
  lines.push(`Следующий ход: роль «${role}» отвечает на дугу «${arcAddr}».`);
  if (section !== null) {
    lines.push(`Напиши раздел «# ${section} ${l1Number}».`);
    lines.push(`Свойства: [fd-from:: ${role}] [fd-createdAt:: <текущее время ISO8601>] [fd-reply:: [[#${arcAddr}]]].`);
    if (section === 'CODE' || section === 'FIX') {
      lines.push('Обязательно добавь в свойства [fd-to:: AI.REVIEWER] — результат идёт на ревью.');
    } else if (section === 'ANSWERS') {
      lines.push('Обязательно добавь в свойства [fd-to:: AI.ANALYST].');
    } else if (section === 'REVIEW') {
      lines.push('Если нашёл замечания — под каждое вложенный «## BUG N» (только новые, не повторяй уже закрытые) со свойствами [fd-from:: AI.REVIEWER] [fd-to:: AI.CODER.SENIOR]. Если замечаний нет — НЕ добавляй fd-to: дальше решает человек (DONE или новый ISSUE).');
    }
  } else {
    lines.push('Раздел выбери сам (ISSUE → QUESTIONS или передача ISSUE дальше; укажи fd-reply на дугу).');
  }
  return lines.join('\n');
}

export function isNotFoundError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /not_found|не найден|not found|does not exist|doesn't exist/i.test(msg);
}

export function makeLookup(mcp: TFdMcpClient, connection: string): TFdDbLookup {
  return async (objPath: string) => {
    const parts = objPath.split('.');
    const name = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    for (const kind of ['procedure', 'function', 'view']) {
      try {
        const text = await mcp.call('get_definition', {
          connection,
          name,
          objectType: kind,
          ...(schema !== undefined ? { schema } : {}),
        });
        const parsed = JSON.parse(text) as { ok?: boolean; definitions?: unknown[] };
        if (parsed.ok === true && (parsed.definitions?.length ?? 0) > 0) {
          return { exists: true, kind };
        }
      } catch (e) {
        // not_found → пробуем следующий objectType; сбой соединения/доступа НЕ скрываем.
        if (isNotFoundError(e)) continue;
        return { exists: null, kind: null };
      }
    }
    return { exists: false, kind: null };
  };
}

export function makeGetDefinition(mcp: TFdMcpClient, connection: string): TFdGetDefinition {
  return async (objPath: string) => {
    const parts = objPath.split('.');
    const name = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    for (const kind of ['procedure', 'function', 'view']) {
      try {
        const text = await mcp.call('get_definition', {
          connection,
          name,
          objectType: kind,
          ...(schema !== undefined ? { schema } : {}),
        });
        const parsed = JSON.parse(text) as { ok?: boolean; definitions?: Array<{ definition?: string }> };
        if (parsed.ok === true && (parsed.definitions?.length ?? 0) > 0) {
          return parsed.definitions![0].definition ?? '';
        }
      } catch (e) {
        // not_found → пробуем следующий objectType; сбой пробрасываем наружу.
        if (isNotFoundError(e)) continue;
        throw e;
      }
    }
    throw new Error(`definition not found: ${objPath}`);
  };
}

/** Снять определения для снапшота: найденные → в снапшот; объект отсутствует → ошибка
 * «объекта нет в БД»; сбой MCP (сеть/права) → отдельная ошибка с текстом. Прогон не роняем. */
export async function snapshotDefinitions(
  objects: TFdDbObject[],
  getDefinition: TFdGetDefinition,
  errors: string[],
): Promise<Array<{ objPath: string; definition: string }>> {
  const found: Array<{ objPath: string; definition: string }> = [];
  for (const o of objects) {
    try {
      found.push({ objPath: o.objPath, definition: await getDefinition(o.objPath) });
    } catch (e) {
      if (isNotFoundError(e)) {
        errors.push(`snapshot: ${o.objPath}: объекта нет в БД`);
      } else {
        errors.push(`snapshot: ${o.objPath}: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }
  return found;
}

function roleTools(spec: TFdSpecConfig, role: string, mcp?: TFdMcpClient): TFdMcpTool[] | undefined {
  if (mcp === undefined) return undefined;
  const names = resolveRole(spec, role).tools;
  if (names === undefined || names.length === 0) return undefined;
  return mcp.tools.filter((t) => names.includes(t.name));
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
  const result: TFdRunResult = { steps: 0, stoppedFor: null, errors: [], hitMaxSteps: false, drySections: [] };

  let journal = await readFile(chatPath, 'utf8');
  let content = textToStructure(journal, true);

  for (let i = 0; i < maxSteps; i++) {
    const step = nextStep(content);
    if (step === null) break; // DONE или нет открытых дуг
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
    const user = buildUserPrompt(role, journal, step.section, step.arc.addr, nextL1Number(content, step.section ?? 'ISSUE'));
    const tools = roleTools(opts.spec, role, opts.mcp);
    const allowedTools = new Set((tools ?? []).map((t) => t.name));
    const callTool = opts.mcp !== undefined
      ? async (n: string, a: Record<string, unknown>) => {
          // Защита: агент может вызвать только инструменты своей роли (SPEC tools).
          if (!allowedTools.has(n)) {
            throw new Error(`инструмент ${n} не разрешён роли ${role}`);
          }
          if (opts.dryRun && n === 'execute_sql') {
            return JSON.stringify({ ok: true, skipped: true, note: 'dry-run: БД не изменялась' });
          }
          return opts.mcp!.call(n, a);
        }
      : undefined;

    // Пре-проверка плана кодера (OBJECT в issue-app.md): create ⇒ объекта ещё нет,
    // edit ⇒ есть, тип в БД совпадает. Только на входе кодера (ISSUE→AI.CODER).
    if (step.section === 'CODE' && opts.mcp !== undefined) {
      const plan = await collectTaskObjects(opts.taskDir);
      // Baseline «до всех изменений»: один раз, при первом входе кодера (план уже
      // зафиксирован в issue-app.md). Для create-объектов список пуст (= «до» ничего
      // не было). В dry-run не пишем.
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
      const valErrs = await validateDbObject(plan, makeLookup(opts.mcp, connection));
      if (valErrs.length > 0) {
        result.errors = valErrs.map((e) => `${e.objPath}: ${e.error}`);
        break;
      }
    }

    const sectionText = await runRole({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      system,
      user,
      tools,
      callTool,
    });

    // dry-run: раздел не пишем в журнал — отдаём текстом наружу и выходим.
    if (opts.dryRun) {
      result.drySections.push(sectionText.trim());
      break;
    }

    journal = `${journal.trimEnd()}\n\n${sectionText.trim()}\n`;
    // Атомарная запись: tmp + rename — журнал никогда не остаётся полузаписанным.
    const tmpPath = `${chatPath}.tmp`;
    await writeFile(tmpPath, journal);
    await rename(tmpPath, chatPath);
    content = textToStructure(journal, true);
    result.steps++;

    const errs = await taskCheck(opts.taskDir);
    if (errs.length > 0) {
      result.errors = errs.map((e) => `${e.relativeFileName}: ${e.error}`);
      break;
    }

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
  // Завершённый таск (DONE) → кандидаты в vault. Ошибка генерации не роняет прогон.
  if (!opts.dryRun && level1List(content).some((l) => l.title === 'DONE')) {
    try {
      await generateKnowledgeCandidates(opts.spec, opts.providers, opts.taskDir, journal);
    } catch {
      // пропускаем: knowledge-candidates — не критично для результата таска
    }
  }
  return result;
}
