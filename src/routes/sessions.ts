import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { BackendDriver } from '../backends/types.js';

export function registerSessionsRoute(app: FastifyInstance, driver: BackendDriver): void {
  if (driver.listSessions) {
    app.get('/v1/sessions', async (_req: FastifyRequest, reply: FastifyReply) => {
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
