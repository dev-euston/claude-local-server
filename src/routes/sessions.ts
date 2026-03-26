import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { BackendDriver } from '../backends/types.js';

export function registerSessionsRoute(app: FastifyInstance, driver: BackendDriver): void {
  if (!driver.deleteSession) return;

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
