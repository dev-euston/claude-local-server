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
    expect(chunks[0]).toEqual({ id: 'chatcmpl-msg-789', delta: 'Hello', finishReason: null });
    expect(chunks[1]).toEqual({ id: 'chatcmpl-msg-789', delta: ' world', finishReason: null });
    expect(chunks[2]).toEqual({ id: 'chatcmpl-msg-789', delta: '', finishReason: 'stop' });
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
