import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { BackendDriver } from '../backends/types.js';

export function registerSessionsRoute(app: FastifyInstance, driver: BackendDriver): void {
  if (driver.listSessions) {
    app.get('/v1/sessions', {
      schema: {
        tags: ['Sessions'],
        summary: 'List all sessions',
        response: {
          200: {
            type: 'object',
            properties: {
              sessions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    lastUsed: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    }, async (_req: FastifyRequest, reply: FastifyReply) => {
      const sessions = driver.listSessions!().map((s) => ({
        id: s.id,
        lastUsed: s.lastUsed.toISOString(),
      }));
      return reply.send({ sessions });
    });
  }

  if (driver.getSession) {
    app.get(
      '/v1/sessions/:id',
      {
        schema: {
          tags: ['Sessions'],
          summary: 'Get a session by ID',
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          response: {
            200: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                lastUsed: { type: 'string', format: 'date-time' },
                messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
            404: {
              type: 'object',
              properties: {
                error: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    type: { type: 'string' },
                    code: { nullable: true },
                  },
                },
              },
            },
          },
        },
      },
      async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const { id } = req.params;
        const session = driver.getSession!(id);
        if (!session) {
          return reply.status(404).send({
            error: { message: 'Session not found', type: 'invalid_request_error', code: null },
          });
        }
        return reply.send({
          id: session.id,
          lastUsed: session.lastUsed.toISOString(),
          messages: session.messages,
        });
      },
    );
  }

  if (driver.deleteSession) {
    app.delete(
      '/v1/sessions/:id',
      {
        schema: {
          tags: ['Sessions'],
          summary: 'Delete a session by ID',
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          response: {
            204: { type: 'null', description: 'Session deleted' },
            404: {
              type: 'object',
              properties: {
                error: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    type: { type: 'string' },
                    code: { nullable: true },
                  },
                },
              },
            },
          },
        },
      },
      async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const { id } = req.params;
        const existed = driver.deleteSession!(id);
        if (!existed) {
          return reply.status(404).send({
            error: { message: 'Session not found', type: 'invalid_request_error', code: null },
          });
        }
        return reply.status(204).send();
      },
    );
  }
}
