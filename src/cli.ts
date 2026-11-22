#!/usr/bin/env node
// CLI автономного рантайма flowdini: `flowdini run <taskDir> [flags]`.
import { readSpec } from 'flowdini-engine';
import { loadProvidersConfig } from './config.js';
import { startMcp } from './mcp.js';
import { run } from './driver.js';

function usage(): string {
  return `flowdini — автономный рантайм (без Hermes/Codex)

Использование:
  flowdini run <taskDir> [flags]

Flags:
  --spec <path>          SPEC-файл (fd.spec.yaml); по умолчанию ./fd.spec.yaml
  --providers <path>     конфиг провайдеров (fd.providers.yaml); по умолчанию ./fd.providers.yaml
  --vvdb <dir>           каталог vv-db-mcp (если задан — подключается MCP для БД)
  --vvdb-config <path>   конфиг vv-db-mcp; по умолчанию <vvdb>/.connect.json
  --vault-root <path>    корень vault для context/fd-vault; по умолчанию cwd
  --connection <name>    имя коннекта БД для vv-db-mcp; по умолчанию mssql
  --max-steps <n>        лимит шагов за запуск; по умолчанию 20
  --dry-run              не писать в журнал (печатать раздел в stdout)
`;
}

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[a] = next;
        i++;
      } else {
        out[a] = 'true';
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv[0] !== 'run') {
    process.stderr.write(usage());
    process.exit(2);
  }
  const taskDir = argv[1];
  const f = flags(argv.slice(2));

  const specPath = f['--spec'] ?? 'fd.spec.yaml';
  const providersPath = f['--providers'] ?? 'fd.providers.yaml';

  const spec = await readSpec(specPath);
  const providers = loadProvidersConfig(providersPath);

  const vvdbDir = f['--vvdb'];
  const mcp = vvdbDir !== undefined
    ? await startMcp(vvdbDir, f['--vvdb-config'] ?? `${vvdbDir}/.connect.json`)
    : undefined;

  const maxSteps = f['--max-steps'] !== undefined ? Number(f['--max-steps']) : 20;

  try {
    const res = await run({
      taskDir,
      spec,
      providers,
      mcp,
      vaultRoot: f['--vault-root'],
      connection: f['--connection'],
      maxSteps,
      dryRun: f['--dry-run'] === 'true',
    });
    if (res.drySections.length > 0) {
      console.log('=== dry-run: раздел, который агент написал бы ===');
      for (const s of res.drySections) console.log(s);
      console.log('=== конец dry-run (журнал и БД не изменены) ===');
      return;
    }
    if (res.steps > 0) {
      console.log(`шагов выполнено: ${res.steps}`);
    }
    if (res.errors.length > 0) {
      console.log('ошибки:');
      for (const e of res.errors) console.log(`  - ${e}`);
      process.exitCode = 1;
    } else if (res.stoppedFor !== null) {
      console.log(`остановка: ждём «${res.stoppedFor}»`);
    } else if (res.hitMaxSteps) {
      console.log(`достигнут лимит шагов (${res.steps}) — есть открытые дуги; запусти снова`);
    } else {
      console.log('открытых AI-дуг нет (DONE или затор)');
    }
  } finally {
    if (mcp !== undefined) await mcp.close();
  }
}

main().catch((e) => {
  process.stderr.write(`flowdini: ${(e as Error).message}\n`);
  process.exit(1);
});
