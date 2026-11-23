// MCP-клиент к vv-db-mcp (stdio). Без лога вызовов (решение владельца, 2026-11-22).
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Версия MCP-клиента = версия flowdini-cli (единый источник — package.json).
const require = createRequire(import.meta.url);
const { version: cliVersion } = require('../package.json') as { version: string };

export interface TFdMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TFdMcpClient {
  tools: TFdMcpTool[];
  call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}

/** Поднять vv-db-mcp как stdio-подпроцесс и отдать клиент. `vvdbDir` — каталог vv-db-mcp. */
export async function startMcp(vvdbDir: string, configPath: string): Promise<TFdMcpClient> {
  const client = new Client({ name: 'flowdini', version: cliVersion });
  const transport = new StdioClientTransport({
    // `dist/cli.js` — входная точка vv-db-mcp (фиксированный stdio-таргет).
    command: 'node',
    args: ['dist/cli.js', '--config', configPath],
    cwd: vvdbDir,
    stderr: 'inherit',
  });
  await client.connect(transport);
  const list = await client.listTools();
  const tools: TFdMcpTool[] = list.tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
  }));
  const call = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    const res = (await client.callTool({ name: tool, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    // Только text-части, через \n (не впустую — иначе несколько частей склеиваются в кашу).
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    if (res.isError === true) {
      throw new Error(`MCP ${tool}: ${text || '(пустое сообщение об ошибке)'}`);
    }
    return text;
  };
  return { tools, call, close: () => client.close() };
}
