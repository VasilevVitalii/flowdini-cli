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
  timeoutMs = 180_000,
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices?: {
      message?: { role?: string; content?: string | null; tool_calls?: TFdToolCall[] };
      finish_reason?: string | null;
    }[];
  };
  const choice = data.choices?.[0];
  if (!choice) throw new Error('LLM: пустой ответ (нет choices)');
  const msg = choice.message;
  if (!msg) throw new Error('LLM: пустой ответ (нет message)');
  // Усечённый по лимиту ответ нельзя принимать за готовое тело CODE/FIX.
  if (choice.finish_reason === 'length') {
    throw new Error('LLM: ответ обрезан провайдером (finish_reason=length)');
  }
  const role = msg.role;
  if (role !== undefined && !['system', 'user', 'assistant', 'tool'].includes(role)) {
    throw new Error(`LLM: неизвестная роль ответа: "${role}"`);
  }
  const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  const content = msg.content ?? null;
  if (!hasToolCalls && (content === null || content.trim() === '')) {
    throw new Error('LLM: пустое тело ответа (нет content и tool_calls)');
  }
  return {
    role: (role as TFdChatMessage['role']) ?? 'assistant',
    content,
    tool_calls: msg.tool_calls,
  };
}
