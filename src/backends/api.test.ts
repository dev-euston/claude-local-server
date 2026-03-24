import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedRequest } from './types.js';

vi.mock('@anthropic-ai/sdk', () => {
  const create = vi.fn();
  return {
    default: vi.fn().mockImplementation(function () {
      return { messages: { create } };
    }),
    _create: create,
  };
});

let ApiBackend: typeof import('./api.js').ApiBackend;
let mockCreate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const sdkMod = await import('@anthropic-ai/sdk');
  mockCreate = (sdkMod as unknown as { _create: ReturnType<typeof vi.fn> })._create;
  const mod = await import('./api.js');
  ApiBackend = mod.ApiBackend;
});

const baseRequest: NormalizedRequest = {
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'claude-opus-4-6',
};

describe('ApiBackend.complete', () => {
  it('returns a NormalizedResponse', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-123',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Hi there!' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const result = await backend.complete(baseRequest);

    expect(result.id).toBe('chatcmpl-msg-123');
    expect(result.content).toBe('Hi there!');
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(5);
  });

  it('passes system message as top-level param, not in messages[]', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-456',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Sure.' }],
      usage: { input_tokens: 20, output_tokens: 3 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await backend.complete({
      ...baseRequest,
      system: 'Be concise.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['system']).toBe('Be concise.');
    expect(
      (callArgs['messages'] as unknown[]).every(
        (m) => (m as Record<string, string>)['role'] !== 'system',
      ),
    ).toBe(true);
  });

  it('omits system param when not provided', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-789',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Ok.' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await backend.complete(baseRequest);

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['system']).toBeUndefined();
  });

  it('propagates SDK errors', async () => {
    mockCreate.mockRejectedValue(new Error('Rate limit exceeded'));
    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await expect(backend.complete(baseRequest)).rejects.toThrow('Rate limit exceeded');
  });

  it('passes temperature when provided', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-temp',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Hot.' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await backend.complete({ ...baseRequest, temperature: 0.5 });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['temperature']).toBe(0.5);
  });
});

describe('ApiBackend.stream', () => {
  it('yields NormalizedChunks from streaming SDK events', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-789' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } };
      yield { type: 'message_stop' };
    }
    // stream: true variant returns the stream directly (not a Promise)
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      type: 'text',
      id: 'chatcmpl-msg-789',
      delta: 'Hello',
      finishReason: null,
    });
    expect(chunks[1]).toEqual({
      type: 'text',
      id: 'chatcmpl-msg-789',
      delta: ' world',
      finishReason: null,
    });
    expect(chunks[2]).toEqual({
      type: 'text',
      id: 'chatcmpl-msg-789',
      delta: '',
      finishReason: 'stop',
    });
  });

  it('ignores non-text-delta events', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-abc' } };
      yield { type: 'content_block_start', content_block: { type: 'text' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } };
      yield { type: 'ping' };
      yield { type: 'content_block_stop' };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2); // 'Hi' chunk + stop chunk
  });

  it('passes system message when streaming', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-sys' } };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');

    for await (const _chunk of backend.stream({ ...baseRequest, system: 'Be brief.' })) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['system']).toBe('Be brief.');
  });

  it('passes temperature when streaming', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-temp-stream' } };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');

    for await (const _chunk of backend.stream({ ...baseRequest, temperature: 0.8 })) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['temperature']).toBe(0.8);
  });
});

describe('ApiBackend.stream — tool events', () => {
  it('yields ToolCallStartChunk on content_block_start with tool_use type', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-tool' } };
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'call_abc', name: 'bash' },
      };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    const start = chunks.find((c) => c.type === 'tool_call_start');
    expect(start).toBeDefined();
    if (start?.type === 'tool_call_start') {
      expect(start.toolCallId).toBe('call_abc');
      expect(start.name).toBe('bash');
      expect(start.toolIndex).toBe(0);
    }
  });

  it('uses capture-then-increment order for toolIndex', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-multi' } };
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'call_1', name: 'bash' },
      };
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'call_2', name: 'read' },
      };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    const starts = chunks.filter((c) => c.type === 'tool_call_start');
    expect(starts).toHaveLength(2);
    if (starts[0].type === 'tool_call_start') expect(starts[0].toolIndex).toBe(0);
    if (starts[1].type === 'tool_call_start') expect(starts[1].toolIndex).toBe(1);
  });

  it('yields ToolCallDeltaChunk on input_json_delta event with correct toolIndex and toolCallId', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-delta' } };
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'call_abc', name: 'bash' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '"ls"}' },
      };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    const deltas = chunks.filter((c) => c.type === 'tool_call_delta');
    expect(deltas).toHaveLength(2);
    if (deltas[0].type === 'tool_call_delta') {
      expect(deltas[0].argumentsDelta).toBe('{"cmd":');
      expect(deltas[0].toolIndex).toBe(0);
      expect(deltas[0].toolCallId).toBe('call_abc');
    }
  });

  it('throws when input_json_delta arrives before any tool_use content_block_start', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-orphan' } };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{}' },
      };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await expect(async () => {
      for await (const _chunk of backend.stream(baseRequest)) {
        // consume
      }
    }).rejects.toThrow(/input_json_delta.*no active tool/i);
  });

  it('never yields ToolResultChunk', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-no-result' } };
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'call_abc', name: 'bash' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{}' },
      };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'tool_result')).toHaveLength(0);
  });

  it('does not yield tool chunk for content_block_start with non-tool type', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-text-block' } };
      yield { type: 'content_block_start', content_block: { type: 'text' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'tool_call_start')).toHaveLength(0);
    expect(chunks.filter((c) => c.type === 'text' && c.delta === 'Hello')).toHaveLength(1);
  });
});

describe('ApiBackend — tool translation', () => {
  it('translates NormalizedRequest.tools to Anthropic format', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-tools',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Ok.' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await backend.complete({
      ...baseRequest,
      tools: [
        { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: {} } },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const tools = callArgs['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]['name']).toBe('bash');
    expect(tools[0]['description']).toBe('Run shell');
    expect(tools[0]['input_schema']).toEqual({ type: 'object', properties: {} });
  });

  it('omits tools field from API call when request.tools is absent', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-no-tools',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Ok.' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await backend.complete(baseRequest);

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['tools']).toBeUndefined();
  });

  it('uses empty input_schema when parameters is absent', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-no-params',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Ok.' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await backend.complete({
      ...baseRequest,
      tools: [{ name: 'noop' }],
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const tools = callArgs['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]['input_schema']).toEqual({ type: 'object', properties: {} });
  });

  it('translates NormalizedRequest.tools to Anthropic format when streaming', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-tools-stream' } };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    for await (const _chunk of backend.stream({
      ...baseRequest,
      tools: [
        { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: {} } },
      ],
    })) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const tools = callArgs['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]['name']).toBe('bash');
    expect(tools[0]['description']).toBe('Run shell');
    expect(tools[0]['input_schema']).toEqual({ type: 'object', properties: {} });
  });

  it('uses empty input_schema when parameters is absent in stream()', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-no-params-stream' } };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    for await (const _chunk of backend.stream({
      ...baseRequest,
      tools: [{ name: 'noop' }],
    })) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const tools = callArgs['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]['input_schema']).toEqual({ type: 'object', properties: {} });
  });
});
