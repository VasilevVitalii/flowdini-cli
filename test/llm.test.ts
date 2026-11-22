import { describe, it, expect, vi, afterEach } from 'vitest';
import { chat } from '../src/llm.js';

describe('chat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('шлёт правильный запрос и возвращает сообщение', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await chat('https://x/v1', 'k', 'm', [{ role: 'user', content: 'yo' }]);
    expect(msg.content).toBe('hi');
    expect(msg.role).toBe('assistant');

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://x/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body).model).toBe('m');
  });

  it('передаёт tools в body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [] } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await chat('https://x/v1', 'k', 'm', [], [{ name: 't', description: 'd', inputSchema: { type: 'object' } }]);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.tools[0].function.name).toBe('t');
    expect(body.tools[0].function.parameters).toEqual({ type: 'object' });
  });

  it('не-200 → throw с текстом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(chat('https://x', 'k', 'm', [])).rejects.toThrow(/500/);
  });

  it('нет choices → throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) }));
    await expect(chat('https://x', 'k', 'm', [])).rejects.toThrow(/choices/);
  });
});
