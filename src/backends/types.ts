/* c8 ignore file -- TypeScript interfaces compile to no executable JS */
export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface NormalizedRequest {
  messages: NormalizedMessage[]; // user/assistant only — no system role
  system?: string; // extracted system prompt
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface NormalizedResponse {
  id: string;
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
}

// One chunk per token delta emitted during streaming
export interface NormalizedChunk {
  id: string;
  delta: string; // text fragment; empty string on final chunk
  finishReason: string | null; // null until final; "stop" on last chunk
}

export interface BackendDriver {
  complete(request: NormalizedRequest): Promise<NormalizedResponse>;
  stream(request: NormalizedRequest): AsyncIterable<NormalizedChunk>;
}
