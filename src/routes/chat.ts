import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { BackendDriver } from '../backends/types.js';
import {
  openAIMessagesToNormalized,
  openAIToolsToNormalized,
  normalizedResponseToOpenAI,
  normalizedChunkToOpenAI,
  normalizedToolCallStartToOpenAI,
  normalizedToolCallDeltaToOpenAI,
  normalizedToolResultToOpenAI,
} from '../transform.js';

interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: object;
}

interface OpenAITool {
  type: string;
  function: OpenAIToolFunction;
}

interface ChatRequestBody {
  messages: { role: string; content: string }[];
  model?: string;
  stream?: boolean;
  stream_actions?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: OpenAITool[];
}

export function registerChatRoute(
  app: FastifyInstance,
  config: Config,
  driver: BackendDriver,
): void {
  const modelName = config.backend === 'api' ? config.api.model : (config.cli.model ?? 'claude');

  app.post(
    '/v1/chat/completions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: { type: 'array', items: { type: 'object' }, minItems: 1 },
            model: { type: 'string' },
            stream: { type: 'boolean' },
            stream_actions: { type: 'boolean' },
            max_tokens: { type: 'number' },
            temperature: { type: 'number' },
            tools: {
              type: 'array',
              items: {
                type: 'object',
                required: ['function'],
                properties: {
                  type: { type: 'string' },
                  function: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                      name: { type: 'string' },
                      description: { type: 'string' },
                      parameters: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: ChatRequestBody }>, reply: FastifyReply) => {
      const body = req.body;

      if (body.stream_actions && !body.stream) {
        return reply.status(400).send({
          error: {
            message: 'stream_actions requires stream: true',
            type: 'invalid_request_error',
            code: null,
          },
        });
      }

      let normalized: {
        messages: import('../backends/types.js').NormalizedMessage[];
        system?: string;
      };
      try {
        normalized = openAIMessagesToNormalized(body.messages);
      } catch (err) {
        return reply.status(400).send({
          error: { message: (err as Error).message, type: 'invalid_request_error', code: null },
        });
      }

      const rawSessionHeader = req.headers['x-session-id'];
      /* c8 ignore next */
      const providedSessionId: string | undefined = Array.isArray(rawSessionHeader)
        ? /* c8 ignore next */
          rawSessionHeader.length > 0
          ? rawSessionHeader[0]
          : undefined
        : rawSessionHeader || undefined;

      let sessionId: string | undefined;
      if (driver.hasSession) {
        if (providedSessionId !== undefined) {
          if (!driver.hasSession(providedSessionId)) {
            return reply.status(404).send({
              error: { message: 'Session not found', type: 'invalid_request_error', code: null },
            });
          }
          sessionId = providedSessionId;
        } else {
          sessionId = randomUUID();
        }
      } else {
        sessionId = providedSessionId;
      }

      const normalizedRequest = {
        messages: normalized.messages,
        system: normalized.system,
        model: modelName,
        maxTokens: body.max_tokens,
        temperature: body.temperature,
        tools: body.tools ? openAIToolsToNormalized(body.tools) : undefined,
        sessionId,
      };

      if (body.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        if (sessionId !== undefined) reply.raw.setHeader('X-Session-ID', sessionId);
        reply.raw.flushHeaders();

        try {
          for await (const chunk of driver.stream(normalizedRequest)) {
            if (chunk.type === 'text') {
              reply.raw.write(
                `data: ${JSON.stringify(normalizedChunkToOpenAI(chunk, modelName))}\n\n`,
              );
            } else if (body.stream_actions) {
              if (chunk.type === 'tool_call_start') {
                reply.raw.write(
                  `data: ${JSON.stringify(normalizedToolCallStartToOpenAI(chunk, modelName))}\n\n`,
                );
              } else if (chunk.type === 'tool_call_delta') {
                reply.raw.write(
                  `data: ${JSON.stringify(normalizedToolCallDeltaToOpenAI(chunk, modelName))}\n\n`,
                );
              } else if (chunk.type === 'tool_result') {
                reply.raw.write(
                  `event: tool_result\ndata: ${JSON.stringify(normalizedToolResultToOpenAI(chunk))}\n\n`,
                );
              }
            }
          }
          reply.raw.write('data: [DONE]\n\n');
        } catch (err) {
          const errEvent = {
            error: { message: (err as Error).message, type: 'server_error', code: null },
          };
          reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
        } finally {
          reply.raw.end();
        }
        return;
      }

      try {
        const response = await driver.complete(normalizedRequest);
        if (sessionId !== undefined) void reply.header('X-Session-ID', sessionId);
        return reply.send(normalizedResponseToOpenAI(response));
      } catch (err) {
        return reply.status(500).send({
          error: { message: (err as Error).message, type: 'server_error', code: null },
        });
      }
    },
  );
}
