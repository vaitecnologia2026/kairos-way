import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';

const widgetConfigSchema = z.object({
  widgets: z.array(
    z.object({
      id     : z.string(),
      enabled: z.boolean(),
    })
  ),
});

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  // GET /dashboard/config — retorna configuração salva pelo usuário
  app.get('/config', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const user   = await prisma.user.findUnique({
      where : { id: userId },
      select: { dashboardConfig: true },
    });
    return reply.send({ config: user?.dashboardConfig ?? null });
  });

  // PUT /dashboard/config — salva configuração do usuário
  app.put('/config', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const body   = widgetConfigSchema.parse(req.body);

    await prisma.user.update({
      where: { id: userId },
      data : { dashboardConfig: body },
    });

    return reply.send({ ok: true });
  });
};
