import { describe, it, expect } from 'vitest';
import {
  openAIMessagesToNormalized,
  normalizedResponseToOpenAI,
  normalizedChunkToOpenAI,
  openAIToolsToNormalized,
  normalizedToolCallStartToOpenAI,
  normalizedToolCallDeltaToOpenAI,
  normalizedToolResultToOpenAI,
} from './transform.js';
import type {
  NormalizedResponse,
  TextChunk,
  ToolCallStartChunk,
  ToolCallDeltaChunk,
  ToolResultChunk,
} from './backends/types.js';

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
    const chunk: TextChunk = {
      type: 'text',
      id: 'chatcmpl-abc',
      delta: 'Hello',
      finishReason: null,
    };
    const result = normalizedChunkToOpenAI(chunk, 'claude-opus-4-6') as Record<string, unknown>;
    expect(result['id']).toBe('chatcmpl-abc');
    expect(result['object']).toBe('chat.completion.chunk');
    const choices = result['choices'] as Array<Record<string, unknown>>;
    const delta = choices[0]['delta'] as Record<string, string>;
    expect(delta['content']).toBe('Hello');
    expect(choices[0]['finish_reason']).toBeNull();
  });

  it('converts the final chunk with finish_reason and empty delta', () => {
    const chunk: TextChunk = { type: 'text', id: 'chatcmpl-abc', delta: '', finishReason: 'stop' };
    const result = normalizedChunkToOpenAI(chunk, 'claude-opus-4-6') as Record<string, unknown>;
    const choices = result['choices'] as Array<Record<string, unknown>>;
    expect(choices[0]['finish_reason']).toBe('stop');
    expect(choices[0]['delta']).toEqual({});
  });
});

describe('openAIToolsToNormalized', () => {
  it('converts OpenAI function tools to NormalizedTool array', () => {
    const result = openAIToolsToNormalized([
      {
        type: 'function',
        function: { name: 'bash', description: 'Run shell', parameters: { type: 'object' } },
      },
    ]);
    expect(result).toEqual([
      { name: 'bash', description: 'Run shell', parameters: { type: 'object' } },
    ]);
  });

  it('handles missing description and parameters', () => {
    const result = openAIToolsToNormalized([{ type: 'function', function: { name: 'read_file' } }]);
    expect(result).toEqual([{ name: 'read_file', description: undefined, parameters: undefined }]);
  });
});

describe('normalizedToolCallStartToOpenAI', () => {
  it('emits OpenAI tool call header chunk with empty arguments', () => {
    const chunk: ToolCallStartChunk = {
      type: 'tool_call_start',
      id: 'chatcmpl-abc',
      toolCallId: 'call_xyz',
      toolIndex: 0,
      name: 'bash',
      finishReason: null,
    };
    const result = normalizedToolCallStartToOpenAI(chunk, 'claude-opus-4-6') as Record<
      string,
      unknown
    >;
    expect(result['id']).toBe('chatcmpl-abc');
    expect(result['object']).toBe('chat.completion.chunk');
    const choices = result['choices'] as Array<Record<string, unknown>>;
    const toolCalls = (choices[0]['delta'] as Record<string, unknown>)['tool_calls'] as Array<
      Record<string, unknown>
    >;
    expect(toolCalls[0]['index']).toBe(0);
    expect(toolCalls[0]['id']).toBe('call_xyz');
    expect(toolCalls[0]['type']).toBe('function');
    const fn = toolCalls[0]['function'] as Record<string, string>;
    expect(fn['name']).toBe('bash');
    expect(fn['arguments']).toBe('');
    expect(choices[0]['finish_reason']).toBeNull();
  });

  it('uses chunk.toolIndex for the tool_calls array index', () => {
    const chunk: ToolCallStartChunk = {
      type: 'tool_call_start',
      id: 'chatcmpl-abc',
      toolCallId: 'call_2',
      toolIndex: 2,
      name: 'read',
      finishReason: null,
    };
    const result = normalizedToolCallStartToOpenAI(chunk, 'claude') as Record<string, unknown>;
    const choices = result['choices'] as Array<Record<string, unknown>>;
    const toolCalls = (choices[0]['delta'] as Record<string, unknown>)['tool_calls'] as Array<
      Record<string, unknown>
    >;
    expect(toolCalls[0]['index']).toBe(2);
  });
});

describe('normalizedToolCallDeltaToOpenAI', () => {
  it('emits arguments delta chunk without id/type/name', () => {
    const chunk: ToolCallDeltaChunk = {
      type: 'tool_call_delta',
      id: 'chatcmpl-abc',
      toolCallId: 'call_xyz',
      toolIndex: 1,
      argumentsDelta: '{"cmd":',
      finishReason: null,
    };
    const result = normalizedToolCallDeltaToOpenAI(chunk, 'claude-opus-4-6') as Record<
      string,
      unknown
    >;
    expect(result['id']).toBe('chatcmpl-abc');
    const choices = result['choices'] as Array<Record<string, unknown>>;
    const toolCalls = (choices[0]['delta'] as Record<string, unknown>)['tool_calls'] as Array<
      Record<string, unknown>
    >;
    expect(toolCalls[0]['index']).toBe(1);
    expect(toolCalls[0]['id']).toBeUndefined();
    expect(toolCalls[0]['type']).toBeUndefined();
    const fn = toolCalls[0]['function'] as Record<string, string>;
    expect(fn['arguments']).toBe('{"cmd":');
    expect(fn['name']).toBeUndefined();
  });
});

describe('normalizedToolResultToOpenAI', () => {
  it('returns a plain object with tool_call_id and content', () => {
    const chunk: ToolResultChunk = {
      type: 'tool_result',
      id: 'chatcmpl-abc',
      toolCallId: 'call_xyz',
      content: 'exit 0',
      finishReason: null,
    };
    const result = normalizedToolResultToOpenAI(chunk) as Record<string, unknown>;
    expect(result['tool_call_id']).toBe('call_xyz');
    expect(result['content']).toBe('exit 0');
  });
});
