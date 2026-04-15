import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { AuditService } from '../audit/audit.service';
import { prisma } from '../../shared/utils/prisma';
import { NotFoundError, ForbiddenError, AppError } from '../../shared/errors/AppError';

const auditService = new AuditService();

export async function productRoutes(app: FastifyInstance) {

  // POST /products
  app.post('/', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(3),
      description: z.string().optional(),
      type: z.enum(['PHYSICAL', 'DIGITAL', 'SUBSCRIPTION', 'BUNDLE']),
      imageUrl: z.string().url().optional(),
      category: z.string().optional(),
      weightGrams: z.number().int().optional(),
      sku: z.string().optional(),
    }).parse(req.body);

    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer || !producer.isActive) throw new AppError('Produtor não aprovado ou inativo', 403);

    const product = await prisma.product.create({
      data: { ...body, producerId: producer.id, status: 'PENDING' },
    });

    await auditService.log({
      userId: req.user.sub, action: 'PRODUCT_CREATED',
      resource: `product:${product.id}`, level: 'LOW',
    });

    return reply.status(201).send(product);
  });

  // GET /products — meus produtos
  app.get('/', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'AFFILIATE')] }, async (req, reply) => {
    const { page = '1', limit = '20', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    let producerId: string | undefined;
    if (req.user.role === 'PRODUCER' || req.user.role === 'AFFILIATE') {
      const p = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      producerId = p?.id;
    }

    const [data, total] = await Promise.all([
      prisma.product.findMany({
        where: { producerId, status: status || undefined, deletedAt: null },
        include: { offers: { where: { isActive: true }, select: { id: true, name: true, priceCents: true, slug: true, type: true } } },
        orderBy: { createdAt: 'desc' },
        skip, take: Number(limit),
      }),
      prisma.product.count({ where: { producerId, deletedAt: null } }),
    ]);

    return reply.send({ data, total, page: Number(page), limit: Number(limit) });
  });

  // GET /products/:id
  app.get('/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = await prisma.product.findUnique({
      where: { id, deletedAt: null },
      include: {
        offers: { where: { isActive: true }, include: { splitRules: { where: { isActive: true } } } },
        coproducers: { where: { isActive: true }, include: { coproducer: { include: { user: { select: { name: true, email: true } } } } } },
      },
    });
    if (!product) throw new NotFoundError('Produto');
    return reply.send(product);
  });

  // PATCH /products/:id
  app.patch('/:id', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'AFFILIATE')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      imageUrl: z.string().url().optional(),
      category: z.string().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);

    const product = await prisma.product.update({
      where: { id, deletedAt: null },
      data: body,
    });

    await auditService.log({
      userId: req.user.sub, action: 'PRODUCT_UPDATED',
      resource: `product:${id}`, level: 'LOW',
    });

    return reply.send(product);
  });

  // DELETE /products/:id (soft delete)
  app.delete('/:id', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'AFFILIATE')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await auditService.log({ userId: req.user.sub, action: 'PRODUCT_DELETED', resource: `product:${id}`, level: 'MEDIUM' });
    return reply.send({ message: 'Produto inativado' });
  });

  // GET /products/vitrine — produtos aprovados (público)
  app.get('/vitrine/list', async (_req, reply) => {
    const products = await prisma.product.findMany({
      where: { status: 'APPROVED', isActive: true, deletedAt: null },
      include: { offers: { where: { isActive: true }, select: { priceCents: true, name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(products);
  });

  // POST /products/:id/approve (admin)
  app.post('/:id/approve', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = await prisma.product.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: req.user.sub },
    });
    await auditService.log({ userId: req.user.sub, action: 'PRODUCT_APPROVED', resource: `product:${id}`, level: 'MEDIUM' });
    return reply.send(product);
  });

  // POST /products/:id/reject (admin)
  app.post('/:id/reject', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().min(5) }).parse(req.body);
    await prisma.product.update({
      where: { id },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectedReason: body.reason },
    });
    await auditService.log({ userId: req.user.sub, action: 'PRODUCT_REJECTED', resource: `product:${id}`, level: 'MEDIUM' });
    return reply.send({ message: 'Produto rejeitado' });
  });
}