# flowdini-cli

Автономный рантайм исполнения ролей flowdini. Сам читает SPEC, сам вызывает
LLM-провайдеров через их API, сам держит MCP-клиент к `vv-db-mcp`, сам пишет
журнал. **Без Hermes / Codex / Claude Code** — внешних агентов нет.

`flowdini-engine` — детерминированная библиотека (планирование, валидация,
снапшоты). `flowdini-cli` — исполнитель поверх неё.

## Установка и запуск

```bash
npm install
npm run build

flowdini run <taskDir> \
  --spec fd.spec.yaml \
  --providers fd.providers.yaml \
  --vvdb ~/work/vv-db-mcp
```

Ключи провайдеров не лежат в конфигах — только имя переменной окружения
(`apiKeyEnv`); сами ключи экспортируются в окружение.

## Конфиги

`fd.spec.yaml` — SPEC-конфиг (см. канон `flowdini-engine/README.md`):
роли, `reviewLimit`, матрица инструментов (`roles[].tools`), `roles[].model`.

`fd.providers.yaml` — маппинг `модель → провайдер`:

```yaml
providers:
  deepseek:
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    models: [deepseek-v4-pro]
  routerai:
    baseUrl: https://routerai.ru/v1
    apiKeyEnv: ROUTERAI_API_KEY
    models: [claude-sonnet-4, gpt-4o]
```

Модель роли (`roles[].model`) ищется в списках `models` провайдеров; если модель
не закреплена — прогон останавливается с ошибкой.

## Цикл исполнения

`nextStep` → `roleBrief` → агент-роль (LLM + инструменты MCP) → раздел журнала →
`taskCheck` → снапшот (после `CODE`/`FIX`). Останавливается, когда:

- `nextStep` вернул `null` (DONE или нет открытых дуг);
- следующая дуга адресована `HUMAN.*` — рантайм не исполняет людей, ждёт их
  вручную (в т.ч. гибридный гейт `## Q` к `HUMAN.CODER`).

Запуск идемпотентен: можно гонять многократно, каждый раз исполняется очередной
AI-шаг до первого `HUMAN.*` или DONE.

## Инструменты БД (MCP)

`--vvdb <dir>` поднимает `vv-db-mcp` как stdio-подпроцесс. Роли получают
инструменты по `roles[].tools` (из `mcpMatrix` SPEC). Кодер — `execute_sql` /
`get_definition`, аналитик/ревьюер — read-only (`get_definition` / `describe_*`).

Лог вызовов MCP не ведём (решение владельца, 2026-11-22): аудит — журнал таска
+ снапшоты.

## SQL-guard

Перед каждым `execute_sql` SQL проверяется (`checkSql`): разрешён только один
statement из `CREATE`/`ALTER`/`DROP PROCEDURE|FUNCTION|VIEW`. DDL таблиц
(`DROP/ALTER TABLE`, `TRUNCATE`) и несколько statements за один вызов
блокируются. Ограничение v1: `;` внутри тела процедуры трактуется как второй
statement — пишите процедуру одним statement без `;` внутри (в T-SQL это
допустимо).

## Модули

- `config.ts` — конфиг провайдеров + `model → провайдер`.
- `llm.ts` — OpenAI-совместимый клиент (`chat/completions`, fetch).
- `agent.ts` — tool-calling цикл роли.
- `mcp.ts` — MCP-клиент к `vv-db-mcp` (stdio).
- `sqlguard.ts` — allowlist для `execute_sql`.
- `driver.ts` — цикл исполнения.
- `cli.ts` — точка входа.
