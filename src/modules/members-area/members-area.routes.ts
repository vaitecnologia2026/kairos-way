import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { AppError, NotFoundError, ForbiddenError } from '../../shared/errors/AppError';

// Verifica se o usuário (PRODUCER) é dono do produto. ADMIN passa direto.
async function assertProductOwner(productId: string, userSub: string, role: string) {
  if (role === 'ADMIN' || role === 'STAFF') return;
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { producerId: true } });
  if (!product) throw new NotFoundError('Produto');
  const producer = await prisma.producer.findUnique({ where: { userId: userSub }, select: { id: true } });
  if (!producer || product.producerId !== producer.id) throw new ForbiddenError();
}

async function assertModuleOwner(moduleId: string, userSub: string, role: string) {
  const mod = await prisma.module.findUnique({
    where : { id: moduleId },
    select: { membersArea: { select: { product: { select: { producerId: true } } } } },
  });
  if (!mod) throw new NotFoundError('Módulo');
  if (role === 'ADMIN' || role === 'STAFF') return;
  const producer = await prisma.producer.findUnique({ where: { userId: userSub }, select: { id: true } });
  if (!producer || mod.membersArea.product.producerId !== producer.id) throw new ForbiddenError();
}

async function assertLessonOwner(lessonId: string, userSub: string, role: string) {
  const lesson = await prisma.lesson.findUnique({
    where : { id: lessonId },
    select: { module: { select: { membersArea: { select: { product: { select: { producerId: true } } } } } } },
  });
  if (!lesson) throw new NotFoundError('Aula');
  if (role === 'ADMIN' || role === 'STAFF') return;
  const producer = await prisma.producer.findUnique({ where: { userId: userSub }, select: { id: true } });
  if (!producer || lesson.module.membersArea.product.producerId !== producer.id) throw new ForbiddenError();
}

// Verifica se o User comprou alguma oferta do produto (Order APPROVED)
async function userBoughtProduct(userId: string, productId: string): Promise<boolean> {
  const count = await prisma.order.count({
    where: {
      status   : 'APPROVED',
      customerId: userId,
      offer    : { productId },
    },
  });
  return count > 0;
}

export async function membersAreaRoutes(app: FastifyInstance) {

  // ───────── PRODUTOR / ADMIN ─────────

  // GET /members-area/products/:productId — busca a área (ou 404 se não criada)
  app.get('/products/:productId', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN', 'STAFF')] }, async (req, reply) => {
    const { productId } = req.params as { productId: string };
    await assertProductOwner(productId, req.user.sub, req.user.role);

    const area = await prisma.membersArea.findUnique({
      where  : { productId },
      include: {
        modules: {
          orderBy: { position: 'asc' },
          include: { lessons: { orderBy: { position: 'asc' } } },
        },
      },
    });
    if (!area) return reply.status(404).send({ message: 'Área de membros ainda não criada' });
    return reply.send(area);
  });

  // POST /members-area/products/:productId — cria a área (1:1 por produto)
  app.post('/products/:productId', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN')] }, async (req, reply) => {
    const { productId } = req.params as { productId: string };
    await assertProductOwner(productId, req.user.sub, req.user.role);

    const product = await prisma.product.findUnique({ where: { id: productId }, select: { type: true } });
    if (product?.type !== 'DIGITAL') {
      throw new AppError('Área de membros só pode ser criada em produtos do tipo Digital.', 422);
    }

    const body = z.object({
      title          : z.string().min(2),
      description    : z.string().optional().nullable(),
      coverUrl       : z.string().url().optional().nullable(),
      commentsEnabled: z.boolean().optional(),
      primaryColor   : z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
      accentColor    : z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
      theme          : z.enum(['dark', 'light']).optional(),
      layout         : z.enum(['sidebar', 'stacked']).optional(),
    }).parse(req.body);

    const existing = await prisma.membersArea.findUnique({ where: { productId } });
    if (existing) throw new AppError('Área de membros já existe para este produto', 409);

    const area = await prisma.membersArea.create({
      data: {
        productId,
        title          : body.title,
        description    : body.description ?? null,
        coverUrl       : body.coverUrl ?? null,
        commentsEnabled: body.commentsEnabled ?? true,
      },
    });
    return reply.status(201).send(area);
  });

  // PATCH /members-area/:id — atualiza dados básicos
  app.patch('/:id', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const area = await prisma.membersArea.findUnique({ where: { id }, select: { productId: true } });
    if (!area) throw new NotFoundError('Área de membros');
    await assertProductOwner(area.productId, req.user.sub, req.user.role);

    const body = z.object({
      title          : z.string().min(2).optional(),
      description    : z.string().optional().nullable(),
      coverUrl       : z.string().url().optional().nullable(),
      commentsEnabled: z.boolean().optional(),
      primaryColor   : z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
      accentColor    : z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
      theme          : z.enum(['dark', 'light']).optional(),
      layout         : z.enum(['sidebar', 'stacked']).optional(),
    }).parse(req.body);

    const updated = await prisma.membersArea.update({ where: { id }, data: body });
    return reply.send(updated);
  });

  // POST /members-area/:id/modules — cria módulo
  app.post('/:id/modules', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const area = await prisma.membersArea.findUnique({ where: { id }, select: { productId: true } });
    if (!area) throw new NotFoundError('Área de membros');
    await assertProductOwner(area.productId, req.user.sub, req.user.role);

    const body = z.object({
      title           : z.string().min(2),
      description     : z.string().optional().nullable(),
      coverUrl        : z.string().url().optional().nullable(),
      releaseAfterDays: z.number().int().min(0).optional(),
      visible         : z.boolean().optional(),
      showPublishDate : z.boolean().optional(),
      showModuleTitle : z.boolean().optional(),
    }).parse(req.body);

    const last = await prisma.module.findFirst({ where: { membersAreaId: id }, orderBy: { position: 'desc' }, select: { position: true } });
    const nextPos = (last?.position ?? -1) + 1;

    const mod = await prisma.module.create({
      data: { ...body, membersAreaId: id, position: nextPos },
    });
    return reply.status(201).send(mod);
  });

  // PATCH /members-area/modules/:moduleId
  app.patch('/modules/:moduleId', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN')] }, async (req, reply) => {
    const { moduleId } = req.params as { moduleId: string };
    await assertModuleOwner(moduleId, req.user.sub, req.user.role);

    const body = z.object({
      title           : z.string().min(2).optional(),
      description     : z.string().optional().nullable(),
      coverUrl        : z.string().url().optional().nullable(),
      releaseAfterDays: z.number().int().min(0).optional(),
      visible         : z.boolean().optional(),
      showPublishDate : z.boolean().optional(),
      showModuleTitle : z.boolean().optional(),
      position        : z.number().int().min(0).optional(),
    }).parse(req.body);

    const updated = await prisma.module.update({ where: { id: moduleId }, data: body });
    return reply.send(updated);
  });

  // DELETE /members-area/modules/:moduleId
  app.delete('/modules/:moduleId', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN')] }, async (req, reply) => {
    const { moduleId } = req.params as { moduleId: string };
    await assertModuleOwner(moduleId, req.user.sub, req.user.role);
    await prisma.module.delete({ where: { id: moduleId } });
    return reply.send({ message: 'Módulo removido' });
  });

  // POST /members-area/modules/:moduleId/lessons
  app.post('/modules/:moduleId/lessons', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN')] }, async (req, reply) => {
    const { moduleId } = req.params as { moduleId: string };
    await assertModuleOwner(moduleId, req.user.sub, req.user.role);

    const body = z.object({
      title        : z.string().min(2),
      description  : z.string().optional().nullable(),
      coverUrl     : z.string().url().optional().nullable(),
      videoUrl     : z.string().url().optional().nullable(),
      videoSource  : z.enum(['YOUTUBE', 'MP4_DIRECT', 'OTHER']).optional().nullable(),
      hideVideo    : z.boolean().optional(),
      defaultPlayer: z.boolean().optional(),
    }).parse(req.body);

    const last = await prisma.lesson.findFirst({ where: { moduleId }, orderBy: { position: 'desc' }, select: { position: true } });
    const nextPos = (last?.position ?? -1) + 1;

    const lesson = await prisma.lesson.create({ data: { ...body, moduleId, position: nextPos } });
    return reply.status(201).send(lesson);
  });

  // PATCH /members-area/lessons/:lessonId
  app.patch('/lessons/:lessonId', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN')] }, async (req, reply) => {
    const { lessonId } = req.params as { lessonId: string };
    await assertLessonOwner(lessonId, req.user.sub, req.user.role);

    const body = z.object({
      title        : z.string().min(2).optional(),
      description  : z.string().optional().nullable(),
      coverUrl     : z.string().url().optional().nullable(),
      videoUrl     : z.string().url().optional().nullable(),
      videoSource  : z.enum(['YOUTUBE', 'MP4_DIRECT', 'OTHER']).optional().nullable(),
      hideVideo    : z.boolean().optional(),
      defaultPlayer: z.boolean().optional(),
      position     : z.number().int().min(0).optional(),
    }).parse(req.body);

    const updated = await prisma.lesson.update({ where: { id: lessonId }, data: body });
    return reply.send(updated);
  });

  // DELETE /members-area/lessons/:lessonId
  app.delete('/lessons/:lessonId', { preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE', 'ADMIN')] }, async (req, reply) => {
    const { lessonId } = req.params as { lessonId: string };
    await assertLessonOwner(lessonId, req.user.sub, req.user.role);
    await prisma.lesson.delete({ where: { id: lessonId } });
    return reply.send({ message: 'Aula removida' });
  });

  // ───────── CLIENTE (acesso após compra) ─────────

  // GET /members-area/customer/products/:productId — cliente que comprou vê o curso
  app.get('/customer/products/:productId', { preHandler: [authenticate] }, async (req, reply) => {
    const { productId } = req.params as { productId: string };

    // Produtor dono também pode visualizar (preview)
    const isOwnerOrAdmin = await (async () => {
      if (req.user.role === 'ADMIN' || req.user.role === 'STAFF') return true;
      const product = await prisma.product.findUnique({ where: { id: productId }, select: { producerId: true } });
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub }, select: { id: true } });
      return !!(product && producer && product.producerId === producer.id);
    })();

    if (!isOwnerOrAdmin) {
      const ok = await userBoughtProduct(req.user.sub, productId);
      if (!ok) throw new ForbiddenError();
    }

    const area = await prisma.membersArea.findUnique({
      where  : { productId },
      include: {
        modules: {
          where  : { visible: true },
          orderBy: { position: 'asc' },
          include: { lessons: { orderBy: { position: 'asc' } } },
        },
      },
    });
    if (!area) return reply.status(404).send({ message: 'Curso ainda não disponível' });
    return reply.send(area);
  });

  // GET /members-area/lessons/:lessonId/comments — cliente/produtor lê comentários
  app.get('/lessons/:lessonId/comments', { preHandler: [authenticate] }, async (req, reply) => {
    const { lessonId } = req.params as { lessonId: string };
    const lesson = await prisma.lesson.findUnique({
      where : { id: lessonId },
      select: { module: { select: { membersArea: { select: { commentsEnabled: true, productId: true, product: { select: { producerId: true } } } } } } },
    });
    if (!lesson) throw new NotFoundError('Aula');
    if (!lesson.module.membersArea.commentsEnabled) return reply.send([]);

    const comments = await prisma.lessonComment.findMany({
      where  : { lessonId },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
      take   : 100,
    });
    return reply.send(comments);
  });

  // POST /members-area/lessons/:lessonId/comments — cliente que comprou OU produtor cria comentário
  app.post('/lessons/:lessonId/comments', { preHandler: [authenticate] }, async (req, reply) => {
    const { lessonId } = req.params as { lessonId: string };
    const body = z.object({ content: z.string().min(1).max(2000) }).parse(req.body);

    const lesson = await prisma.lesson.findUnique({
      where : { id: lessonId },
      select: { module: { select: { membersArea: { select: { commentsEnabled: true, productId: true, product: { select: { producerId: true } } } } } } },
    });
    if (!lesson) throw new NotFoundError('Aula');
    if (!lesson.module.membersArea.commentsEnabled) throw new AppError('Comentários desabilitados nesta área', 403);

    // Permissão: dono OR comprador OR admin
    const isOwnerOrAdmin = await (async () => {
      if (req.user.role === 'ADMIN' || req.user.role === 'STAFF') return true;
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub }, select: { id: true } });
      return !!(producer && lesson.module.membersArea.product.producerId === producer.id);
    })();
    if (!isOwnerOrAdmin) {
      const bought = await userBoughtProduct(req.user.sub, lesson.module.membersArea.productId);
      if (!bought) throw new ForbiddenError();
    }

    const comment = await prisma.lessonComment.create({
      data: { lessonId, userId: req.user.sub, content: body.content },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
    return reply.status(201).send(comment);
  });

  // DELETE /members-area/comments/:commentId — autor do comentário OU produtor dono OU admin
  app.delete('/comments/:commentId', { preHandler: [authenticate] }, async (req, reply) => {
    const { commentId } = req.params as { commentId: string };
    const comment = await prisma.lessonComment.findUnique({
      where : { id: commentId },
      select: {
        userId: true,
        lesson: { select: { module: { select: { membersArea: { select: { product: { select: { producerId: true } } } } } } } },
      },
    });
    if (!comment) throw new NotFoundError('Comentário');

    const isAuthor = comment.userId === req.user.sub;
    const isAdmin  = req.user.role === 'ADMIN' || req.user.role === 'STAFF';
    let isOwner = false;
    if (!isAuthor && !isAdmin) {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub }, select: { id: true } });
      isOwner = !!(producer && comment.lesson.module.membersArea.product.producerId === producer.id);
    }
    if (!isAuthor && !isAdmin && !isOwner) throw new ForbiddenError();

    await prisma.lessonComment.delete({ where: { id: commentId } });
    return reply.send({ message: 'Comentário removido' });
  });

  // GET /members-area/customer/my-courses — lista cursos que o cliente comprou
  app.get('/customer/my-courses', { preHandler: [authenticate] }, async (req, reply) => {
    const orders = await prisma.order.findMany({
      where  : { status: 'APPROVED', customerId: req.user.sub },
      select : {
        offer: {
          select: {
            product: {
              select: {
                id: true, name: true, imageUrl: true, type: true,
                membersArea: { select: { id: true, title: true, coverUrl: true } },
              },
            },
          },
        },
      },
    });

    const seen = new Set<string>();
    const courses = [];
    for (const o of orders) {
      const p = o.offer.product;
      if (!p.membersArea || seen.has(p.id)) continue;
      seen.add(p.id);
      courses.push({
        productId  : p.id,
        productName: p.name,
        coverUrl   : p.membersArea.coverUrl || p.imageUrl,
        title      : p.membersArea.title,
      });
    }
    return reply.send(courses);
  });
}
