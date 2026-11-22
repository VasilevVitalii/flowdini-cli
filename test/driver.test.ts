import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeLookup,
  makeGetDefinition,
  collectTaskObjects,
  buildUserPrompt,
  isNotFoundError,
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

describe('buildUserPrompt', () => {
  it('CODE подсказывает fd-to:: AI.REVIEWER', () => {
    const p = buildUserPrompt('AI.CODER.JUNIOR', 'журнал', 'CODE', 'ISSUE 1', 1);
    expect(p).toContain('fd-to:: AI.REVIEWER');
    expect(p).toContain('[fd-from:: AI.CODER.JUNIOR]');
  });

  it('REVIEW подсказывает вложенные ## BUG N', () => {
    const p = buildUserPrompt('AI.REVIEWER', 'журнал', 'REVIEW', 'CODE 1', 2);
    expect(p).toContain('## BUG N');
    expect(p).toContain('AI.CODER.SENIOR');
  });
});
