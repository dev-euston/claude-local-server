import { describe, it, expect } from 'vitest';
import {
  openAIMessagesToNormalized,
  normalizedResponseToOpenAI,
  normalizedChunkToOpenAI,
} from './transform.js';
import type { NormalizedResponse, NormalizedChunk } from './backends/types.js';

describe('openAIMessagesToNormalized', () => {
  it('maps user and assistant messages', () => {
    const result = openAIMessagesToNormalized([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
    expect(result.system).toBeUndefined();
  });

  it('extracts first system message as system prompt', () => {
    const result = openAIMessagesToNormalized([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(result.system).toBe('You are helpful.');
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('uses only the first system message when multiple present', () => {
    const result = openAIMessagesToNormalized([
      { role: 'system', content: 'First' },
      { role: 'system', content: 'Second' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(result.system).toBe('First');
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('throws on unsupported role', () => {
    expect(() => openAIMessagesToNormalized([{ role: 'tool' as never, content: 'x' }])).toThrow(
      'Unsupported message role: tool',
    );
  });
});

describe('normalizedResponseToOpenAI', () => {
  it('converts a NormalizedResponse to ChatCompletion shape', () => {
    const response: NormalizedResponse = {
      id: 'chatcmpl-123',
      model: 'claude-opus-4-6',
      content: 'Hello!',
      promptTokens: 10,
      completionTokens: 5,
    };
    const result = normalizedResponseToOpenAI(response) as Record<string, unknown>;
    expect(result['id']).toBe('chatcmpl-123');
    expect(result['object']).toBe('chat.completion');
    expect(result['model']).toBe('claude-opus-4-6');
    const choices = result['choices'] as Array<Record<string, unknown>>;
    const msg = choices[0]['message'] as Record<string, string>;
    expect(msg['role']).toBe('assistant');
    expect(msg['content']).toBe('Hello!');
    expect(choices[0]['finish_reason']).toBe('stop');
    const usage = result['usage'] as Record<string, number>;
    expect(usage['prompt_tokens']).toBe(10);
    expect(usage['completion_tokens']).toBe(5);
    expect(usage['total_tokens']).toBe(15);
  });
});

describe('normalizedChunkToOpenAI', () => {
  it('converts a mid-stream chunk', () => {
    const chunk: NormalizedChunk = { id: 'chatcmpl-abc', delta: 'Hello', finishReason: null };
    const result = normalizedChunkToOpenAI(chunk, 'claude-opus-4-6') as Record<string, unknown>;
    expect(result['id']).toBe('chatcmpl-abc');
    expect(result['object']).toBe('chat.completion.chunk');
    const choices = result['choices'] as Array<Record<string, unknown>>;
    const delta = choices[0]['delta'] as Record<string, string>;
    expect(delta['content']).toBe('Hello');
    expect(choices[0]['finish_reason']).toBeNull();
  });

  it('converts the final chunk with finish_reason and empty delta', () => {
    const chunk: NormalizedChunk = { id: 'chatcmpl-abc', delta: '', finishReason: 'stop' };
    const result = normalizedChunkToOpenAI(chunk, 'claude-opus-4-6') as Record<string, unknown>;
    const choices = result['choices'] as Array<Record<string, unknown>>;
    expect(choices[0]['finish_reason']).toBe('stop');
    expect(choices[0]['delta']).toEqual({});
  });
});
