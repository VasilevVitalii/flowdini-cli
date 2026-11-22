// OpenAI-совместимый LLM-клиент (chat/completions). Без внешних SDK — fetch.
export interface TFdToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface TFdChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: TFdToolCall[];
  tool_call_id?: string;
}

export interface TFdTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function chat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: TFdChatMessage[],
  tools?: TFdTool[],
): Promise<TFdChatMessage> {
  const body: Record<string, unknown> = { model, messages };
  if (tools !== undefined && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { role?: string; content?: string | null; tool_calls?: TFdToolCall[] } }[];
  };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('LLM: пустой ответ (нет choices)');
  return {
    role: (msg.role as TFdChatMessage['role']) ?? 'assistant',
    content: msg.content ?? null,
    tool_calls: msg.tool_calls,
  };
}
