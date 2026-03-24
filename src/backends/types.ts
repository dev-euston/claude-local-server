/* c8 ignore file -- TypeScript interfaces compile to no executable JS */
export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface NormalizedTool {
  name: string;
  description?: string;
  parameters?: object; // JSON Schema
}

export interface NormalizedRequest {
  messages: NormalizedMessage[]; // user/assistant only — no system role
  system?: string; // extracted system prompt
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: NormalizedTool[];
}

export interface NormalizedResponse {
  id: string;
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
}

// The id field on every chunk is the response-level completion ID
// (same value across all chunks in a single response).
// toolCallId identifies one specific tool invocation.

// Existing text delta. finishReason is non-null only on the terminal chunk.
// Both backends always emit a terminal TextChunk (delta: "", finishReason: "stop")
// at the end of a response, even when the response included tool calls.
// The only emitted non-null finishReason is "stop".
export type TextChunk = {
  type: 'text';
  id: string;
  delta: string;
  finishReason: string | null;
};

// Emitted once per tool use. toolIndex: capture counter value, then increment.
// The OpenAI "arguments": "" on the start chunk is synthesized by the transform layer.
export type ToolCallStartChunk = {
  type: 'tool_call_start';
  id: string;
  toolCallId: string;
  toolIndex: number;
  name: string;
  finishReason: null;
};

// Streaming fragment of tool call arguments.
// toolIndex must equal the toolIndex of the corresponding ToolCallStartChunk.
export type ToolCallDeltaChunk = {
  type: 'tool_call_delta';
  id: string;
  toolCallId: string;
  toolIndex: number;
  argumentsDelta: string;
  finishReason: null;
};

// Tool result. CLI backend only — API backend never yields this type.
// content is always a plain string; array content is joined before yielding.
export type ToolResultChunk = {
  type: 'tool_result';
  id: string;
  toolCallId: string;
  content: string;
  finishReason: null;
};

export type NormalizedChunk = TextChunk | ToolCallStartChunk | ToolCallDeltaChunk | ToolResultChunk;

export interface BackendDriver {
  complete(request: NormalizedRequest): Promise<NormalizedResponse>;
  stream(request: NormalizedRequest): AsyncIterable<NormalizedChunk>;
}
