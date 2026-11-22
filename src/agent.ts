// Роль-агент: tool-calling цикл поверх LLM. Возвращает итоговый текст раздела.
import { chat } from './llm.js';
import type { TFdChatMessage, TFdTool } from './llm.js';

export interface TFdRunRoleOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  tools?: TFdTool[];
  callTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxTurns?: number;
}

export async function runRole(opts: TFdRunRoleOpts): Promise<string> {
  const maxTurns = opts.maxTurns ?? 8;
  const messages: TFdChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await chat(opts.baseUrl, opts.apiKey, opts.model, messages, opts.tools);
    if (msg.tool_calls !== undefined && msg.tool_calls.length > 0) {
      if (opts.callTool === undefined) {
        throw new Error(`LLM запросил инструмент ${msg.tool_calls[0].function.name}, но callTool не задан`);
      }
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let result: string;
        try {
          const args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
          result = await opts.callTool(tc.function.name, args);
        } catch (e) {
          result = `ERROR: ${(e as Error).message}`;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
    }
    return msg.content ?? '';
  }
  throw new Error(`LLM: превышен лимит ходов (${maxTurns})`);
}
