import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../server.js';
import type { Config } from '../config.js';
import type { BackendDriver, NormalizedChunk } from '../backends/types.js';

const cfg: Config = {
  backend: 'api',
  host: '127.0.0.1',
  port: 3000,
  api: { apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
};

function makeMockDriver(overrides: Partial<BackendDriver> = {}): BackendDriver {
  return {
    complete: vi.fn().mockResolvedValue({
      id: 'chatcmpl-test',
      model: 'claude-opus-4-6',
      content: 'Hello!',
      promptTokens: 10,
      completionTokens: 5,
    }),
    stream: vi.fn().mockImplementation(async function* () {
      yield { id: 'chatcmpl-test', delta: 'Hello', finishReason: null } as NormalizedChunk;
      yield { id: 'chatcmpl-test', delta: '', finishReason: 'stop' } as NormalizedChunk;
    }),
    ...overrides,
  };
}

describe('POST /v1/chat/completions — non-streaming', () => {
  it('returns a ChatCompletion response', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: false },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['object']).toBe('chat.completion');
    const choices = body['choices'] as Array<Record<string, unknown>>;
    expect((choices[0]['message'] as Record<string, string>)['content']).toBe('Hello!');
  });

  it('passes system message from request to driver', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hi' },
        ],
      },
    });
    const callArg = (driver.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as import('../backends/types.js').NormalizedRequest;
    expect(callArg.system).toBe('Be brief.');
    expect(callArg.messages.every((m) => (m.role as string) !== 'system')).toBe(true);
  });

  it('returns 400 for unsupported message role', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'tool', content: 'x' }] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Unsupported message role/);
  });

  it('returns 400 when messages is missing', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 500 when backend throws', async () => {
    const driver = makeMockDriver({
      complete: vi.fn().mockRejectedValue(new Error('Backend failure')),
    });
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    expect(response.statusCode).toBe(500);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Backend failure/);
  });
});

describe('POST /v1/chat/completions — streaming', () => {
  it('returns SSE stream with correct event format', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);

    const lines = response.body.split('\n').filter(Boolean);
    const dataLines = lines.filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
    const chunk = JSON.parse(dataLines[0].replace('data: ', '')) as Record<string, unknown>;
    expect(chunk['object']).toBe('chat.completion.chunk');
    expect(response.body).toContain('data: [DONE]');
  });

  it('sends SSE error event when backend stream throws', async () => {
    const driver = makeMockDriver({
      stream: vi.fn().mockImplementation(async function* () {
        yield { id: 'chatcmpl-test', delta: 'Partial', finishReason: null } as NormalizedChunk;
        throw new Error('stream exploded');
      }),
    });
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(response.body).toContain('"error"');
    expect(response.body).toContain('stream exploded');
    expect(response.body).not.toContain('[DONE]');
  });
});
