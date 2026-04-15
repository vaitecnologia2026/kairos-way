import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { AuditService } from '../audit/audit.service';
import { createId } from '@paralleldrive/cuid2';

const audit = new AuditService();

export async function coproducerRequestRoutes(app: FastifyInstance) {

  // GET /coproducer-requests/my-status — afiliado verifica status da sua solicitação
  app.get('/my-status', { preHandler: [authenticate] }, async (req, reply) => {
    const request = await prisma.coproducerRequest.findFirst({
      where  : { userId: req.user.sub, productId: null },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ status: request?.status || null, requestId: request?.id || null });
  });

  // POST /coproducer-requests — afiliado solicita upgrade para co-produtor
  app.post('/', { preHandler: [authenticate] }, async (req, reply) => {
    // Só afiliados podem solicitar
    if (req.user.role !== 'AFFILIATE') {
      return reply.status(400).send({ message: 'Somente afiliados podem solicitar ser co-produtor.' });
    }

    // Verificar se já existe solicitação pendente
    const existing = await prisma.coproducerRequest.findFirst({
      where: { userId: req.user.sub, productId: null, status: 'PENDING' },
    });
    if (existing) {
      return reply.status(409).send({ message: 'Você já tem uma solicitação em análise.', status: 'PENDING' });
    }

    const request = await prisma.coproducerRequest.create({
      data: {
        userId   : req.user.sub,
        productId: null,
        status   : 'PENDING',
        message  : 'Solicitação de upgrade para co-produtor',
      },
    });

    await audit.log({
      userId : req.user.sub,
      action : 'COPRODUCER_REQUEST_CREATED',
      details: { requestId: request.id },
      level  : 'MEDIUM',
    });

    return reply.status(201).send({ message: 'Solicitação enviada com sucesso!', status: 'PENDING' });
  });

  // GET /coproducer-requests — produtor/admin lista solicitações pendentes
  app.get('/', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'STAFF')] }, async (req, reply) => {
    const requests = await prisma.coproducerRequest.findMany({
      where  : { productId: null },
      orderBy: { createdAt: 'desc' },
    });

    // Buscar dados dos usuários
    const userIds = [...new Set(requests.map(r => r.userId))];
    const users   = await prisma.user.findMany({
      where : { id: { in: userIds } },
      select: { id: true, name: true, email: true, phone: true },
    });
    const userMap = new Map(users.map(u => [u.id, u]));

    return reply.send(requests.map(r => ({
      ...r,
      user: userMap.get(r.userId) || null,
    })));
  });

  // POST /coproducer-requests/:id/approve — aprovar solicitação
  app.post('/:id/approve', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'STAFF')] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const request = await prisma.coproducerRequest.findUnique({ where: { id } });
    if (!request) return reply.status(404).send({ message: 'Solicitação não encontrada' });
    if (request.status !== 'PENDING') {
      return reply.status(400).send({ message: `Solicitação já está com status ${request.status}` });
    }

    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) return reply.status(404).send({ message: 'Usuário não encontrado' });

    await prisma.$transaction(async (tx) => {
      // 1. Marcar welcome — role permanece AFFILIATE
      await tx.user.update({
        where: { id: request.userId },
        data : { showCoproducerWelcome: true },
      });

      // 2. Habilitar criação de produtos no perfil de afiliado
      await tx.affiliate.update({
        where: { userId: request.userId },
        data : { canCreateProducts: true },
      });

      // 3. Criar perfil de Producer para que possa criar produtos próprios
      const existingProd = await tx.producer.findUnique({ where: { userId: request.userId } });
      if (!existingProd) {
        await tx.producer.create({
          data: {
            userId    : request.userId,
            kycStatus : 'APPROVED',
            isActive  : true,
            approvedBy: req.user.sub,
            approvedAt: new Date(),
          },
        });
      }

      // 4. Atualizar solicitação
      await tx.coproducerRequest.update({
        where: { id },
        data : { status: 'APPROVED', resolvedBy: req.user.sub, resolvedAt: new Date() },
      });
    });

    await audit.log({
      userId : req.user.sub,
      action : 'COPRODUCER_REQUEST_APPROVED',
      details: { requestId: id, targetUserId: request.userId },
      level  : 'HIGH',
    });

    return reply.send({ message: 'Co-produtor aprovado com sucesso!' });
  });

  // POST /coproducer-requests/:id/reject — rejeitar solicitação
  app.post('/:id/reject', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'STAFF')] }, async (req, reply) => {
    const { id }    = req.params as { id: string };
    const { reason } = (req.body as any) || {};

    const request = await prisma.coproducerRequest.findUnique({ where: { id } });
    if (!request) return reply.status(404).send({ message: 'Solicitação não encontrada' });

    await prisma.coproducerRequest.update({
      where: { id },
      data : {
        status    : 'REJECTED',
        resolvedBy: req.user.sub,
        resolvedAt: new Date(),
        message   : reason || request.message,
      },
    });

    await audit.log({
      userId : req.user.sub,
      action : 'COPRODUCER_REQUEST_REJECTED',
      details: { requestId: id, reason },
      level  : 'MEDIUM',
    });

    return reply.send({ message: 'Solicitação rejeitada.' });
  });

  // POST /coproducer-requests/dismiss-welcome — afiliado/coprodutor dispensa o modal de boas-vindas
  app.post('/dismiss-welcome', { preHandler: [authenticate] }, async (req, reply) => {
    await prisma.user.update({
      where: { id: req.user.sub },
      data : { showCoproducerWelcome: false },
    });
    return reply.send({ ok: true });
  });
}