import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedTool,
  TextChunk,
  ToolCallStartChunk,
  ToolCallDeltaChunk,
  ToolResultChunk,
} from './backends/types.js';

const SUPPORTED_ROLES = new Set(['system', 'user', 'assistant']);

interface OpenAIMessage {
  role: string;
  content: string;
}

interface OpenAITool {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

export function openAIMessagesToNormalized(
  messages: OpenAIMessage[],
): Pick<NormalizedRequest, 'messages' | 'system'> {
  let system: string | undefined;
  const normalized: NormalizedMessage[] = [];

  for (const msg of messages) {
    if (!SUPPORTED_ROLES.has(msg.role)) {
      throw new Error(`Unsupported message role: ${msg.role}`);
    }
    if (msg.role === 'system') {
      if (system === undefined) system = msg.content; // first system wins; extras dropped
    } else {
      normalized.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
    }
  }

  return { messages: normalized, system };
}

export function openAIToolsToNormalized(tools: OpenAITool[]): NormalizedTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

export function normalizedResponseToOpenAI(response: NormalizedResponse): object {
  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: response.content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: response.promptTokens,
      completion_tokens: response.completionTokens,
      total_tokens: response.promptTokens + response.completionTokens,
    },
  };
}

export function normalizedChunkToOpenAI(chunk: TextChunk, model: string): object {
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: chunk.finishReason ? {} : { content: chunk.delta },
        finish_reason: chunk.finishReason,
        logprobs: null,
      },
    ],
  };
}

export function normalizedToolCallStartToOpenAI(chunk: ToolCallStartChunk, model: string): object {
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: chunk.toolIndex,
              id: chunk.toolCallId,
              type: 'function',
              function: { name: chunk.name, arguments: '' },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

export function normalizedToolCallDeltaToOpenAI(chunk: ToolCallDeltaChunk, model: string): object {
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: chunk.toolIndex,
              function: { arguments: chunk.argumentsDelta },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

export function normalizedToolResultToOpenAI(chunk: ToolResultChunk): object {
  return {
    tool_call_id: chunk.toolCallId,
    content: chunk.content,
  };
}
