import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

export function registerModelsRoute(app: FastifyInstance, config: Config): void {
  const modelId = config.backend === 'api' ? config.api.model : config.cli.model;

  app.get('/v1/models', async (_req, reply) => {
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
