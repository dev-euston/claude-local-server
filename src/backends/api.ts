import Anthropic from '@anthropic-ai/sdk';
import type {
  BackendDriver,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedChunk,
} from './types.js';

export class ApiBackend implements BackendDriver {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: (t.parameters ?? {
                type: 'object',
                properties: {},
              }) as Anthropic.Tool['input_schema'],
            })),
          }
        : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    });

    const content = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    return {
      id: `chatcmpl-${response.id}`,
      model: response.model,
      content,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    };
  }

  async *stream(request: NormalizedRequest): AsyncIterable<NormalizedChunk> {
    // The SDK returns an AsyncIterable<StreamEvent> directly when stream: true
    const eventStream = this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: (t.parameters ?? {
                type: 'object',
                properties: {},
              }) as Anthropic.Tool['input_schema'],
            })),
          }
        : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }) as unknown as AsyncIterable<Record<string, unknown>>;

    let id = 'chatcmpl-unknown';
    let toolIndex = 0;
    let activeToolIndex = -1;
    let activeToolCallId = '';

    for await (const event of eventStream) {
      if (event['type'] === 'message_start') {
        id = `chatcmpl-${(event['message'] as { id: string }).id}`;
      } else if (event['type'] === 'content_block_start') {
        const block = event['content_block'] as Record<string, unknown>;
        if (block['type'] === 'tool_use') {
          const capturedIndex = toolIndex;
          activeToolIndex = capturedIndex;
          activeToolCallId = block['id'] as string;
          toolIndex++;
          yield {
            type: 'tool_call_start',
            id,
            toolCallId: activeToolCallId,
            toolIndex: capturedIndex,
            name: block['name'] as string,
            finishReason: null,
          };
        }
      } else if (
        event['type'] === 'content_block_delta' &&
        (event['delta'] as { type: string }).type === 'text_delta'
      ) {
        yield {
          type: 'text',
          id,
          delta: (event['delta'] as { text: string }).text,
          finishReason: null,
        };
      } else if (
        event['type'] === 'content_block_delta' &&
        (event['delta'] as { type: string }).type === 'input_json_delta'
      ) {
        if (activeToolIndex === -1) {
          throw new Error('input_json_delta received with no active tool call block');
        }
        yield {
          type: 'tool_call_delta',
          id,
          toolCallId: activeToolCallId,
          toolIndex: activeToolIndex,
          argumentsDelta: (event['delta'] as { partial_json: string }).partial_json,
          finishReason: null,
        };
      } else if (event['type'] === 'message_stop') {
        yield { type: 'text', id, delta: '', finishReason: 'stop' };
      }
    }
  }
}
