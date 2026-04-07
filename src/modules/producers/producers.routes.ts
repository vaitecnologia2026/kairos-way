import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { AuditService } from '../audit/audit.service';
import { prisma } from '../../shared/utils/prisma';
import { NotFoundError, AppError } from '../../shared/errors/AppError';
import { enqueueEmail } from '../../shared/queue/workers';

const auditService = new AuditService();

export async function producerRoutes(app: FastifyInstance) {

  // ── GET /producers/me ─────────────────────────────────────────
  app.get('/me', {
    preHandler: [authenticate, requireRole('PRODUCER')],
  }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({
      where  : { userId: req.user.sub },
      include: { user: { select: { name: true, email: true, phone: true, document: true } } },
    });
    if (!producer) throw new NotFoundError('Produtor');
    return reply.send(producer);
  });

  // ── POST /producers/kyc/documents ─────────────────────────────
  app.post('/kyc/documents', {
    preHandler: [authenticate, requireRole('PRODUCER')],
  }, async (req, reply) => {
    const body = z.object({
      type: z.string().min(2),
      url : z.string().url(),
    }).parse(req.body);

    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer) throw new NotFoundError('Produtor');

    const doc = await prisma.kycDocument.create({
      data: { producerId: producer.id, type: body.type, url: body.url },
    });

    await prisma.producer.update({
      where: { id: producer.id },
      data : { kycStatus: 'DOCUMENTS_SENT' },
    });

    await auditService.log({
      userId  : req.user.sub,
      action  : 'KYC_DOCUMENT_SENT',
      details : { documentType: body.type },
      level   : 'MEDIUM',
    });

    return reply.status(201).send(doc);
  });

  // ── GET /producers/kyc/status ─────────────────────────────────
  app.get('/kyc/status', {
    preHandler: [authenticate, requireRole('PRODUCER')],
  }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({
      where  : { userId: req.user.sub },
      include: { kycDocuments: true },
    });
    if (!producer) throw new NotFoundError('Produtor');
    return reply.send({ kycStatus: producer.kycStatus, documents: producer.kycDocuments });
  });

  // ── GET /producers/dashboard ──────────────────────────────────
  app.get('/dashboard', {
    preHandler: [authenticate, requireRole('PRODUCER')],
  }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer) throw new NotFoundError('Produtor');

    const [products, recentOrders, balance] = await Promise.all([
      prisma.product.count({ where: { producerId: producer.id, isActive: true } }),
      prisma.order.findMany({
        where  : { offer: { product: { producerId: producer.id } }, status: 'APPROVED' },
        take   : 10,
        orderBy: { createdAt: 'desc' },
        include: { offer: { include: { product: { select: { name: true } } } } },
      }),
      prisma.splitRecord.aggregate({
        where: { recipientId: req.user.sub, status: 'PENDING' },
        _sum : { amountCents: true },
      }),
    ]);

    return reply.send({
      products,
      recentOrders,
      pendingBalanceCents: balance._sum.amountCents || 0,
    });
  });

  // ── GET /producers — listar todos (admin) ─────────────────────
  app.get('/', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { page = '1', limit = '20', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (status) where.kycStatus = status.toUpperCase();

    const [data, total] = await Promise.all([
      prisma.producer.findMany({
        where,
        include: { user: { select: { name: true, email: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        skip, take: Number(limit),
      }),
      prisma.producer.count({ where }),
    ]);

    return reply.send({ data, total, page: Number(page), limit: Number(limit) });
  });

  // ── POST /producers/:id/approve ───────────────────────────────
  app.post('/:id/approve', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const producer = await prisma.producer.update({
      where  : { id },
      data   : { kycStatus: 'APPROVED', isActive: true, approvedAt: new Date(), approvedBy: req.user.sub },
      include: { user: true },
    });

    await prisma.user.update({
      where: { id: producer.userId },
      data : { isActive: true },
    });

    await auditService.log({
      userId  : req.user.sub,
      action  : 'PRODUCER_APPROVED',
      details : { producerId: id, producerEmail: producer.user.email },
      level   : 'HIGH',
    });

    // Notificar produtor da aprovação
    await enqueueEmail(
      producer.user.email,
      'Sua conta foi aprovada!',
      'producer-approved',
      {
        name        : producer.user.name,
        dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`,
      }
    );

    return reply.send({ message: 'Produtor aprovado com sucesso', producer });
  });

  // ── POST /producers/:id/reject ────────────────────────────────
  app.post('/:id/reject', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body   = z.object({
      reason: z.string().min(10, 'Informe o motivo da rejeição (mínimo 10 caracteres)'),
    }).parse(req.body);

    const producer = await prisma.producer.update({
      where  : { id },
      data   : { kycStatus: 'REJECTED', rejectedAt: new Date(), rejectedBy: req.user.sub, rejectedReason: body.reason },
      include: { user: true },
    });

    await auditService.log({
      userId  : req.user.sub,
      action  : 'PRODUCER_REJECTED',
      details : { producerId: id, reason: body.reason },
      level   : 'HIGH',
    });

    // Notificar produtor da rejeição com motivo
    await enqueueEmail(
      producer.user.email,
      'Atualização sobre sua conta Kairos Way',
      'producer-rejected',
      {
        name  : producer.user.name,
        reason: body.reason,
      }
    );

    return reply.send({ message: 'Produtor rejeitado' });
  });

  // ── POST /producers/:id/block ─────────────────────────────────
  app.post('/:id/block', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body   = z.object({ reason: z.string().min(5) }).parse(req.body);

    const producer = await prisma.producer.update({
      where: { id },
      data : { isActive: false },
    });
    await prisma.user.update({
      where: { id: producer.userId },
      data : { isActive: false },
    });

    // Revogar todas as sessões do produtor bloqueado
    await prisma.session.deleteMany({ where: { userId: producer.userId } });

    await auditService.log({
      userId  : req.user.sub,
      action  : 'PRODUCER_BLOCKED',
      details : { producerId: id, reason: body.reason },
      level   : 'HIGH',
    });

    return reply.send({ message: 'Produtor bloqueado e sessões revogadas' });
  });
}