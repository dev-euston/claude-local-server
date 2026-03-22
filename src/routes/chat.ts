import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { BackendDriver } from '../backends/types.js';
import {
  openAIMessagesToNormalized,
  normalizedResponseToOpenAI,
  normalizedChunkToOpenAI,
} from '../transform.js';

interface ChatRequestBody {
  messages: { role: string; content: string }[];
  model?: string;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export function registerChatRoute(
  app: FastifyInstance,
  config: Config,
  driver: BackendDriver,
): void {
  const modelName = config.backend === 'api' ? config.api.model : config.cli.model;

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
            max_tokens: { type: 'number' },
            temperature: { type: 'number' },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: ChatRequestBody }>, reply: FastifyReply) => {
      const body = req.body;

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

      const normalizedRequest = {
        messages: normalized.messages,
        system: normalized.system,
        model: modelName,
        maxTokens: body.max_tokens,
        temperature: body.temperature,
      };

      if (body.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.flushHeaders();

        try {
          for await (const chunk of driver.stream(normalizedRequest)) {
            const sseChunk = normalizedChunkToOpenAI(chunk, modelName);
            reply.raw.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
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
        return reply.send(normalizedResponseToOpenAI(response));
      } catch (err) {
        return reply.status(500).send({
          error: { message: (err as Error).message, type: 'server_error', code: null },
        });
      }
    },
  );
}
