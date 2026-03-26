import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../server.js';
import type { Config } from '../config.js';
import type { BackendDriver, NormalizedChunk, NormalizedRequest } from '../backends/types.js';

const cfg: Config = {
  backend: 'api',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
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
      yield {
        type: 'text',
        id: 'chatcmpl-test',
        delta: 'Hello',
        finishReason: null,
      } as NormalizedChunk;
      yield {
        type: 'text',
        id: 'chatcmpl-test',
        delta: '',
        finishReason: 'stop',
      } as NormalizedChunk;
    }),
    ...overrides,
  };
}

const mockDriverWithToolChunks: BackendDriver = {
  stream: async function* (_request: NormalizedRequest) {
    yield {
      type: 'tool_call_start',
      id: 'chatcmpl-t1',
      toolCallId: 'call_1',
      toolIndex: 0,
      name: 'bash',
      finishReason: null,
    };
    yield {
      type: 'tool_call_delta',
      id: 'chatcmpl-t1',
      toolCallId: 'call_1',
      toolIndex: 0,
      argumentsDelta: '{"cmd":"ls"}',
      finishReason: null,
    };
    yield {
      type: 'tool_result',
      id: 'chatcmpl-t1',
      toolCallId: 'call_1',
      content: 'file.txt',
      finishReason: null,
    };
    yield { type: 'text', id: 'chatcmpl-t1', delta: '', finishReason: 'stop' };
  },
  complete: async (_request: NormalizedRequest) => ({
    id: 'chatcmpl-t1',
    model: 'claude',
    content: '',
    promptTokens: 0,
    completionTokens: 0,
  }),
};

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

  it('non-streaming: content is empty string when complete() returns empty content', async () => {
    const emptyContentDriver = {
      stream: async function* () {
        yield { type: 'text' as const, id: 'x', delta: '', finishReason: 'stop' as const };
      },
      complete: async () => ({
        id: 'chatcmpl-x',
        model: 'claude',
        content: '',
        promptTokens: 0,
        completionTokens: 0,
      }),
    };
    const app = await buildApp(cfg, emptyContentDriver);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe('');
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
        yield {
          type: 'text',
          id: 'chatcmpl-test',
          delta: 'Partial',
          finishReason: null,
        } as NormalizedChunk;
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

  it('final SSE chunk has finish_reason: "stop" and empty delta', async () => {
    const driverForFinishReason = {
      stream: async function* () {
        yield {
          type: 'tool_call_start' as const,
          id: 'chatcmpl-f',
          toolCallId: 'call_f',
          toolIndex: 0,
          name: 'bash',
          finishReason: null as null,
        };
        yield {
          type: 'text' as const,
          id: 'chatcmpl-f',
          delta: '',
          finishReason: 'stop' as string | null,
        };
      },
      complete: async () => ({
        id: 'chatcmpl-f',
        model: 'claude',
        content: '',
        promptTokens: 0,
        completionTokens: 0,
      }),
    };
    const app = await buildApp(cfg, driverForFinishReason);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(response.statusCode).toBe(200);
    const dataLines = response.body
      .split('\n')
      .filter((l: string) => l.startsWith('data: ') && l !== 'data: [DONE]');
    const lastChunk = JSON.parse(dataLines[dataLines.length - 1].replace('data: ', '')) as Record<
      string,
      unknown
    >;
    const choices = lastChunk['choices'] as Array<Record<string, unknown>>;
    expect(choices[0]['finish_reason']).toBe('stop');
    expect(choices[0]['delta']).toEqual({});
  });
});

describe('POST /v1/chat/completions — stream_actions', () => {
  it('stream_actions: true + stream: true — all four SSE chunks present with correct framing', async () => {
    const app = await buildApp(cfg, mockDriverWithToolChunks);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        stream_actions: true,
      },
    });
    expect(response.statusCode).toBe(200);

    const body = response.body;

    // tool_call_start chunk — collect data: lines that are NOT preceded by event: tool_result
    const lines = body.split('\n');
    const standardDataLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        const prevLine = i > 0 ? lines[i - 1] : '';
        if (prevLine !== 'event: tool_result') {
          standardDataLines.push(line);
        }
      }
    }
    const chunks = standardDataLines.map(
      (l: string) => JSON.parse(l.replace('data: ', '')) as Record<string, unknown>,
    );

    // Should have 3 data: chunks (tool_call_start, tool_call_delta, text)
    expect(chunks.length).toBe(3);
    expect(chunks[0]['object']).toBe('chat.completion.chunk');
    expect(chunks[1]['object']).toBe('chat.completion.chunk');
    expect(chunks[2]['object']).toBe('chat.completion.chunk');

    // tool_result uses event: tool_result framing
    expect(body).toContain('event: tool_result');
    const eventLines = body.split('\n');
    const toolResultEventIdx = eventLines.findIndex((l: string) => l === 'event: tool_result');
    expect(toolResultEventIdx).toBeGreaterThanOrEqual(0);
    const toolResultDataLine = eventLines[toolResultEventIdx + 1];
    expect(toolResultDataLine).toMatch(/^data: /);
    const toolResultData = JSON.parse(toolResultDataLine.replace('data: ', '')) as Record<
      string,
      unknown
    >;
    expect(toolResultData['tool_call_id']).toBe('call_1');
    expect(toolResultData['content']).toBe('file.txt');
  });

  it('stream_actions: false + stream: true — tool chunks absent from output', async () => {
    const app = await buildApp(cfg, mockDriverWithToolChunks);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        stream_actions: false,
      },
    });
    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).not.toContain('event: tool_result');
    expect(body).not.toContain('tool_call_start');

    // Only the text chunk should be present
    const dataLines = body
      .split('\n')
      .filter((l: string) => l.startsWith('data: ') && l !== 'data: [DONE]');
    expect(dataLines.length).toBe(1);
  });

  it('stream_actions absent + stream: true — tool chunks absent from output', async () => {
    const app = await buildApp(cfg, mockDriverWithToolChunks);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).not.toContain('event: tool_result');

    const dataLines = body
      .split('\n')
      .filter((l: string) => l.startsWith('data: ') && l !== 'data: [DONE]');
    expect(dataLines.length).toBe(1);
  });

  it('stream_actions: true + stream: false — returns HTTP 400', async () => {
    const app = await buildApp(cfg, mockDriverWithToolChunks);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        stream_actions: true,
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toBe('stream_actions requires stream: true');
  });

  it('stream_actions: true — unknown chunk type is silently skipped', async () => {
    const driverWithUnknownChunk: BackendDriver = {
      stream: async function* (_request: NormalizedRequest) {
        // Inject a chunk type that is not in the union — exercises the false branch of
        // the final else-if in the stream handler
        yield {
          type: 'unknown_future_type',
          id: 'chatcmpl-u',
          finishReason: null,
        } as unknown as NormalizedChunk;
        yield { type: 'text', id: 'chatcmpl-u', delta: '', finishReason: 'stop' };
      },
      complete: async (_request: NormalizedRequest) => ({
        id: 'chatcmpl-u',
        model: 'claude',
        content: '',
        promptTokens: 0,
        completionTokens: 0,
      }),
    };
    const app = await buildApp(cfg, driverWithUnknownChunk);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        stream_actions: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('[DONE]');
  });

  it('stream_actions: true + no tools field — valid response (no 400)', async () => {
    const app = await buildApp(cfg, mockDriverWithToolChunks);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        stream_actions: true,
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('stream_actions: true + malformed tools entry — returns HTTP 400', async () => {
    const app = await buildApp(cfg, mockDriverWithToolChunks);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        stream_actions: true,
        tools: [{ function: {} }], // missing name
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('tools present in request — NormalizedRequest.tools passed to driver', async () => {
    let capturedRequest: NormalizedRequest | undefined;
    const capturingDriver: BackendDriver = {
      stream: async function* (request: NormalizedRequest) {
        capturedRequest = request;
        yield { type: 'text', id: 'chatcmpl-cap', delta: '', finishReason: 'stop' };
      },
      complete: async (_request: NormalizedRequest) => ({
        id: 'chatcmpl-cap',
        model: 'claude',
        content: '',
        promptTokens: 0,
        completionTokens: 0,
      }),
    };

    const app = await buildApp(cfg, capturingDriver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        tools: [
          {
            type: 'function',
            function: { name: 'bash', description: 'Run bash', parameters: { type: 'object' } },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.tools).toBeDefined();
    expect(capturedRequest!.tools).toHaveLength(1);
    expect(capturedRequest!.tools![0].name).toBe('bash');
    expect(capturedRequest!.tools![0].description).toBe('Run bash');
  });
});

describe('POST /v1/chat/completions — X-Session-ID header', () => {
  it('string header → sessionId threaded into NormalizedRequest (non-streaming)', async () => {
    let captured: NormalizedRequest | undefined;
    const driver: BackendDriver = {
      complete: async (req) => {
        captured = req;
        return { id: 'x', model: 'claude', content: '', promptTokens: 0, completionTokens: 0 };
      },
      stream: async function* () {
        yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' };
      },
    };
    const app = await buildApp(cfg, driver);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'my-session' },
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    expect(captured?.sessionId).toBe('my-session');
  });

  it('string header → sessionId threaded into NormalizedRequest (streaming)', async () => {
    let captured: NormalizedRequest | undefined;
    const driver: BackendDriver = {
      complete: async () => ({
        id: 'x',
        model: 'claude',
        content: '',
        promptTokens: 0,
        completionTokens: 0,
      }),
      stream: async function* (req) {
        captured = req;
        yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' };
      },
    };
    const app = await buildApp(cfg, driver);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'my-session' },
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(captured?.sessionId).toBe('my-session');
  });

  it('absent header → sessionId is undefined', async () => {
    let captured: NormalizedRequest | undefined;
    const driver: BackendDriver = {
      complete: async (req) => {
        captured = req;
        return { id: 'x', model: 'claude', content: '', promptTokens: 0, completionTokens: 0 };
      },
      stream: async function* () {
        yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' };
      },
    };
    const app = await buildApp(cfg, driver);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    expect(captured?.sessionId).toBeUndefined();
  });

  it('empty-array header → sessionId is undefined', async () => {
    let captured: NormalizedRequest | undefined;
    const driver: BackendDriver = {
      complete: async (req) => {
        captured = req;
        return { id: 'x', model: 'claude', content: '', promptTokens: 0, completionTokens: 0 };
      },
      stream: async function* () {
        yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' };
      },
    };
    const app = await buildApp(cfg, driver);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': [] },
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    expect(captured?.sessionId).toBeUndefined();
  });
});

describe('POST /v1/chat/completions — server-managed sessions', () => {
  function makeSessionDriver(knownIds: string[] = []) {
    const sessions = new Set(knownIds);
    let captured: NormalizedRequest | undefined;
    const driver: BackendDriver = {
      hasSession: (id: string) => sessions.has(id),
      complete: async (req) => {
        captured = req;
        return { id: 'x', model: 'claude', content: '', promptTokens: 0, completionTokens: 0 };
      },
      stream: async function* (req) {
        captured = req;
        yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' };
      },
    };
    return { driver, getCapture: () => captured };
  }

  it('no header → generates UUID session ID and returns it in X-Session-ID response header (non-streaming)', async () => {
    const { driver, getCapture } = makeSessionDriver();
    const app = await buildApp(cfg, driver);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    expect(res.statusCode).toBe(200);
    const returnedId = res.headers['x-session-id'];
    expect(typeof returnedId).toBe('string');
    expect(returnedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(getCapture()?.sessionId).toBe(returnedId);
  });

  it('no header → generates UUID session ID and returns it in X-Session-ID response header (streaming)', async () => {
    const { driver, getCapture } = makeSessionDriver();
    const app = await buildApp(cfg, driver);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    const returnedId = res.headers['x-session-id'];
    expect(typeof returnedId).toBe('string');
    expect(returnedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(getCapture()?.sessionId).toBe(returnedId);
  });

  it('known session ID → passes through and echoes X-Session-ID in response header (non-streaming)', async () => {
    const { driver, getCapture } = makeSessionDriver(['existing-session']);
    const app = await buildApp(cfg, driver);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'existing-session' },
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-session-id']).toBe('existing-session');
    expect(getCapture()?.sessionId).toBe('existing-session');
  });

  it('known session ID → passes through and echoes X-Session-ID in response header (streaming)', async () => {
    const { driver, getCapture } = makeSessionDriver(['existing-session']);
    const app = await buildApp(cfg, driver);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'existing-session' },
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-session-id']).toBe('existing-session');
    expect(getCapture()?.sessionId).toBe('existing-session');
  });

  it('unknown session ID → 404 session not found (non-streaming)', async () => {
    const { driver } = makeSessionDriver();
    const app = await buildApp(cfg, driver);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'unknown-session' },
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Session not found');
  });

  it('unknown session ID → 404 session not found (streaming)', async () => {
    const { driver } = makeSessionDriver();
    const app = await buildApp(cfg, driver);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'unknown-session' },
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Session not found');
  });
});
