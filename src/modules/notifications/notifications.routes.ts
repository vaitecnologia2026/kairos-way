import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { AppError } from '../../shared/errors/AppError';

export const notificationRoutes: FastifyPluginAsync = async (app) => {

  // GET /notifications — lista notificações do usuário (últimas 50)
  app.get('/', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    const notifications = await prisma.notification.findMany({
      where  : { userId },
      orderBy: { createdAt: 'desc' },
      take   : 50,
    });

    return reply.send({ data: notifications });
  });

  // GET /notifications/unread-count — contador de não lidas
  app.get('/unread-count', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    const count = await prisma.notification.count({
      where: { userId, isRead: false },
    });

    return reply.send({ count });
  });

  // PUT /notifications/read-all — marca todas como lidas
  app.put('/read-all', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data : { isRead: true },
    });

    return reply.send({ ok: true });
  });

  // PUT /notifications/:id/read — marca uma como lida
  app.put('/:id/read', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const { id } = req.params as { id: string };

    const notification = await prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!notification) throw new AppError('Notificação não encontrada', 404);

    await prisma.notification.update({
      where: { id },
      data : { isRead: true },
    });

    return reply.send({ ok: true });
  });
};
