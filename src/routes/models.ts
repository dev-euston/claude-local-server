import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

export function registerModelsRoute(app: FastifyInstance, config: Config): void {
  const modelId = config.backend === 'api' ? config.api.model : (config.cli.model ?? 'claude');

  app.get('/v1/models', {
    schema: {
      tags: ['Models'],
      summary: 'List available models',
      response: {
        200: {
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  object: { type: 'string', enum: ['model'] },
                  created: { type: 'number' },
                  owned_by: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_req, reply) => {
    return reply.send({
      object: 'list',
      data: [
        {
          id: modelId,
          object: 'model',
          created: 1741000000,
          owned_by: 'anthropic',
        },
      ],
    });
  });
}
