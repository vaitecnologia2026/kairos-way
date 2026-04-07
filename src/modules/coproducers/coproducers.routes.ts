// ── COPRODUCERS ROUTES ───────────────────────────────────────────────
import { FastifyInstance as FF } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { NotFoundError, AppError } from '../../shared/errors/AppError';
import { AuditService } from '../audit/audit.service';

const audit = new AuditService();

export async function coproducerRoutes(app: FF) {

  // POST /coproducers/request — co-prod solicita entrar num produto
  app.post('/request', { preHandler: [authenticate, requireRole('COPRODUCER')] }, async (req, reply) => {
    const body = z.object({ productId: z.string(), message: z.string().optional() }).parse(req.body);
    const req2 = await prisma.coproducerRequest.create({
      data: { userId: req.user.sub, productId: body.productId, message: body.message },
    });
    return reply.status(201).send(req2);
  });

  // GET /coproducers/requests — produtor vê solicitações dos seus produtos
  app.get('/requests', { preHandler: [authenticate, requireRole('PRODUCER')] }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    const requests = await prisma.coproducerRequest.findMany({
      where: { product: { producerId: producer?.id }, status: 'PENDING' },
      include: { product: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(requests);
  });

  // POST /coproducers/requests/:id/approve
  app.post('/requests/:id/approve', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = await prisma.coproducerRequest.update({
      where: { id }, data: { status: 'APPROVED', resolvedBy: req.user.sub, resolvedAt: new Date() },
    });

    // Criar vínculo co-produtor ↔ produto
    let coproducer = await prisma.coproducer.findUnique({ where: { userId: request.userId } });
    if (!coproducer) {
      coproducer = await prisma.coproducer.create({ data: { userId: request.userId } });
    }

    await prisma.coproducerProduct.upsert({
      where: { coproducerId_productId: { coproducerId: coproducer.id, productId: request.productId } },
      create: { coproducerId: coproducer.id, productId: request.productId, authorizedBy: req.user.sub },
      update: { isActive: true, authorizedBy: req.user.sub, authorizedAt: new Date() },
    });

    await audit.log({ userId: req.user.sub, action: 'COPRODUCER_APPROVED', details: { requestId: id }, level: 'MEDIUM' });
    return reply.send({ message: 'Co-produtor aprovado' });
  });

  // DELETE /coproducers/:cpId/products/:productId — remover co-prod de produto
  app.delete('/:cpId/products/:productId', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const { cpId, productId } = req.params as { cpId: string; productId: string };
    await prisma.coproducerProduct.updateMany({
      where: { coproducerId: cpId, productId }, data: { isActive: false },
    });
    await audit.log({ userId: req.user.sub, action: 'COPRODUCER_REMOVED', details: { cpId, productId }, level: 'MEDIUM' });
    return reply.send({ message: 'Co-produtor removido do produto' });
  });

  // GET /coproducers — produtor lista co-produtores dos seus produtos
  app.get('/', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });

    const cpProducts = await prisma.coproducerProduct.findMany({
      where: {
        isActive : true,
        product  : { producerId: producer?.id },
      },
      include: {
        coproducer: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
      distinct: ['coproducerId'],
    });

    const data = cpProducts.map(cp => ({
      id    : cp.coproducer.id,
      userId: cp.coproducer.userId,
      user  : cp.coproducer.user,
    }));

    return reply.send({ data });
  });

  // GET /coproducers/my-products — co-prod vê seus produtos
  app.get('/my-products', { preHandler: [authenticate, requireRole('COPRODUCER')] }, async (req, reply) => {
    const coproducer = await prisma.coproducer.findUnique({
      where: { userId: req.user.sub },
      include: { products: { where: { isActive: true }, include: { product: { include: { offers: { include: { splitRules: { where: { isActive: true } } } } } } } } },
    });
    return reply.send(coproducer?.products || []);
  });
}