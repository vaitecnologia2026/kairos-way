import { FastifyInstance }                          from 'fastify';
import { z }                                         from 'zod';
import { authenticate, requireRole }                 from '../../shared/middleware/auth.middleware';
import { prisma }                                    from '../../shared/utils/prisma';
import { AuditService }                              from '../audit/audit.service';
import { createId }                                  from '@paralleldrive/cuid2';
import bcrypt                                          from 'bcryptjs';
import { logger }                                    from '../../shared/utils/logger';

const audit = new AuditService();

export async function affiliatesRoutes(app: FastifyInstance) {

  // ─── REGISTRO PÚBLICO ────────────────────────────────────────────────────

  // POST /affiliates/register — cadastro público de afiliado
  app.post('/register', async (req, reply) => {
    const body = z.object({
      name    : z.string().min(2),
      email   : z.string().email(),
      password: z.string().min(6),
      phone   : z.string().optional(),
      document: z.string().optional(),
    }).parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) return reply.status(409).send({ message: 'E-mail já cadastrado.' });

    const passwordHash = await bcrypt.hash(body.password, 12);

    const user = await prisma.user.create({
      data: {
        name    : body.name,
        email   : body.email,
        passwordHash,
        role    : 'AFFILIATE',
        phone   : body.phone,
        document: body.document,
        isActive: false, // inativo até aprovação
      },
    });

    // Criar perfil de afiliado com status PENDING
    const affiliate = await prisma.affiliate.create({
      data: {
        userId  : user.id,
        code    : createId().slice(0, 8).toUpperCase(),
        isActive: false,
        status  : 'PENDING',
      },
    });
    logger.info({ userId: user.id, affiliateId: affiliate.id, email: body.email }, 'Afiliado: cadastro realizado — aguardando aprovação');

    // Notifica admins
    const { notifyAffiliatePending } = await import('../../shared/utils/notify');
    await notifyAffiliatePending(body.name);

    return reply.status(201).send({
      message: 'Cadastro realizado! Aguarde a aprovação do produtor para acessar a plataforma.',
    });
  });

  // ─── ROTAS DO PRODUTOR ────────────────────────────────────────────────────

  // GET /affiliates/offers — ofertas do produtor com config de afiliação
  app.get('/offers', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer && req.user.role !== 'ADMIN') return reply.send([]);

    const where = req.user.role === 'ADMIN' ? {} : {
      product: { producerId: producer!.id },
    };

    const offers = await prisma.offer.findMany({
      where,
      include: {
        product            : { select: { name: true, imageUrl: true } },
        affiliateConfig    : true,
        _count             : { select: { affiliateEnrollments: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send(offers);
  });

  // POST /affiliates/offers/:offerId/config — habilitar/configurar afiliação
  app.post('/offers/:offerId/config', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const { offerId } = req.params as { offerId: string };
    const body = z.object({
      enabled      : z.boolean(),
      commissionBps: z.number().int().min(100).max(5000), // 1% a 50%
      cookieDays   : z.number().int().min(1).max(90).default(30),
      description  : z.string().max(200).optional(),
    }).parse(req.body);

    const offer = await prisma.offer.findUnique({
      where  : { id: offerId },
      include: { product: { select: { producerId: true } } },
    });

    if (!offer) return reply.status(404).send({ message: 'Oferta não encontrada' });

    if (req.user.role !== 'ADMIN') {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      if (!producer || offer.product.producerId !== producer.id) {
        return reply.status(403).send({ message: 'Sem permissão' });
      }
    }

    const config = await prisma.affiliateConfig.upsert({
      where : { offerId },
      create: { offerId, ...body },
      update: body,
    });

    return reply.send(config);
  });

  // GET /affiliates/offers/:offerId/enrollments — afiliados inscritos
  app.get('/offers/:offerId/enrollments', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const { offerId } = req.params as { offerId: string };

    const enrollments = await prisma.affiliateEnrollment.findMany({
      where  : { offerId },
      include: {
        affiliate: { include: { user: { select: { name: true, email: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send(enrollments);
  });

  // GET /affiliates/pending — afiliados (filtra por status)
  app.get('/pending', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'STAFF')] }, async (req, reply) => {
    const { status } = req.query as { status?: string };
    const affiliates = await prisma.affiliate.findMany({
      where  : status ? { status } : {},
      include: { user: { select: { id: true, name: true, email: true, phone: true, document: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(affiliates);
  });

  // POST /affiliates/:id/approve — produtor/admin aprova afiliado
  app.post('/:id/approve', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'STAFF')] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const affiliate = await prisma.affiliate.findUnique({
      where  : { id },
      include: { user: true },
    });
    if (!affiliate) return reply.status(404).send({ message: 'Afiliado não encontrado' });

    // Ativar usuário e afiliado
    await prisma.$transaction([
      prisma.affiliate.update({
        where: { id },
        data : { status: 'APPROVED', isActive: true, approvedBy: req.user.sub, approvedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: affiliate.userId },
        data : { isActive: true },
      }),
    ]);

    await audit.log({
      userId : req.user.sub, action: 'AFFILIATE_APPROVED',
      details: { affiliateId: id, affiliateEmail: affiliate.user.email }, level: 'MEDIUM',
    });
    logger.info({ affiliateId: id, email: affiliate.user.email, approvedBy: req.user.sub }, 'Afiliado: aprovado');

    const { notifyAffiliateApproved } = await import('../../shared/utils/notify');
    await notifyAffiliateApproved({ affiliateUserId: affiliate.userId });

    return reply.send({ message: 'Afiliado aprovado com sucesso!' });
  });

  // POST /affiliates/:id/reject — produtor/admin rejeita afiliado
  app.post('/:id/reject', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'STAFF')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().optional() }).parse(req.body);

    const affiliate = await prisma.affiliate.findUnique({ where: { id }, select: { userId: true } });

    await prisma.affiliate.update({
      where: { id },
      data : {
        status        : 'REJECTED',
        rejectedBy    : req.user.sub,
        rejectedAt    : new Date(),
        rejectedReason: reason,
      },
    });

    await audit.log({
      userId : req.user.sub, action: 'AFFILIATE_REJECTED',
      details: { affiliateId: id, reason }, level: 'MEDIUM',
    });
    logger.info({ affiliateId: id, reason, rejectedBy: req.user.sub }, 'Afiliado: rejeitado');

    if (affiliate?.userId) {
      const { notifyAffiliateRejected } = await import('../../shared/utils/notify');
      await notifyAffiliateRejected({ affiliateUserId: affiliate.userId, reason });
    }

    return reply.send({ message: 'Afiliado rejeitado.' });
  });

  // ─── ROTAS DO AFILIADO ────────────────────────────────────────────────────

  // GET /affiliates/marketplace — ofertas disponíveis para afiliar
  // Só retorna ofertas com: affiliateConfig habilitado + splits configurados
  // (evita mostrar link que não pode efetivar venda)
  app.get('/marketplace', { preHandler: [authenticate] }, async (req, reply) => {
    const configs = await prisma.affiliateConfig.findMany({
      where  : {
        enabled: true,
        offer  : {
          isActive  : true,
          deletedAt : null,
          splitRules: { some: { isActive: true } },  // só ofertas com splits configurados
        },
      },
      include: {
        offer: {
          include: {
            product: { select: { name: true, imageUrl: true, type: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Buscar inscrições do afiliado atual (se existir)
    const affiliate = await prisma.affiliate.findUnique({ where: { userId: req.user.sub } });
    const myEnrollments = affiliate
      ? await prisma.affiliateEnrollment.findMany({
          where : { affiliateId: affiliate.id },
          select: { offerId: true, status: true },
        })
      : [];

    const myOfferMap = new Map(myEnrollments.map(e => [e.offerId, e.status]));

    return reply.send(configs.map(c => ({
      offerId      : c.offerId,
      offerName    : c.offer.name,
      productName  : c.offer.product.name,
      productImage : c.offer.product.imageUrl,
      commissionBps: c.commissionBps,
      commissionPct: c.commissionBps / 100,
      cookieDays   : c.cookieDays,
      description  : c.description,
      myStatus     : myOfferMap.get(c.offerId) || null,
    })));
  });

  // POST /affiliates/enroll — se inscrever em uma oferta
  app.post('/enroll', { preHandler: [authenticate] }, async (req, reply) => {
    const { offerId } = z.object({ offerId: z.string() }).parse(req.body);

    const config = await prisma.affiliateConfig.findUnique({ where: { offerId, enabled: true } });
    if (!config) return reply.status(404).send({ message: 'Oferta não disponível para afiliação' });

    // Valida que a oferta tem splits ativos — sem isso o checkout falha
    const splitCount = await prisma.splitRule.count({ where: { offerId, isActive: true } });
    if (splitCount === 0) {
      return reply.status(422).send({
        message: 'Oferta ainda não tem splits configurados. Aguarde o produtor completar a configuração antes de se afiliar.',
      });
    }

    // Criar perfil de afiliado se não existir
    let affiliate = await prisma.affiliate.findUnique({ where: { userId: req.user.sub } });
    if (!affiliate) {
      affiliate = await prisma.affiliate.create({
        data: {
          userId: req.user.sub,
          code  : createId().slice(0, 8).toUpperCase(),
        },
      });
    }

    // Verificar se já inscrito
    const existing = await prisma.affiliateEnrollment.findUnique({
      where: { affiliateId_offerId: { affiliateId: affiliate.id, offerId } },
    });
    if (existing) return reply.send(existing);

    const enrollment = await prisma.affiliateEnrollment.create({
      data: {
        affiliateId: affiliate.id,
        offerId,
        status     : 'ACTIVE',
        link       : `${process.env.FRONTEND_URL}/checkout/${(await prisma.offer.findUnique({ where: { id: offerId }, select: { slug: true } }))?.slug}?ref=${affiliate.code}`,
      },
    });

    return reply.status(201).send(enrollment);
  });

  // GET /affiliates/my-enrollments — minhas inscrições e links
  app.get('/my-enrollments', { preHandler: [authenticate] }, async (req, reply) => {
    const affiliate = await prisma.affiliate.findUnique({ where: { userId: req.user.sub } });
    if (!affiliate) return reply.send([]);

    const enrollments = await prisma.affiliateEnrollment.findMany({
      where  : { affiliateId: affiliate.id },
      include: {
        offer: {
          include: {
            product      : { select: { name: true, imageUrl: true } },
            affiliateConfig: { select: { commissionBps: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Para cada inscrição, buscar estatísticas
    const result = await Promise.all(enrollments.map(async (e) => {
      const [clicks, conversions, revenue] = await Promise.all([
        prisma.affiliateTracking.count({ where: { affiliateId: affiliate.id, offerId: e.offerId } }),
        prisma.affiliateTracking.count({ where: { affiliateId: affiliate.id, offerId: e.offerId, orderId: { not: null } } }),
        prisma.splitRecord.aggregate({
          where: { recipientId: req.user.sub, recipientType: 'AFFILIATE', order: { offerId: e.offerId } },
          _sum : { amountCents: true },
        }),
      ]);

      return {
        id           : e.id,
        offerId      : e.offerId,
        offerName    : e.offer.name,
        productName  : e.offer.product.name,
        productImage : e.offer.product.imageUrl,
        commissionBps: e.offer.affiliateConfig?.commissionBps || 0,
        link         : e.link,
        status       : e.status,
        clicks,
        conversions,
        revenueCents : revenue._sum.amountCents || 0,
        createdAt    : e.createdAt,
      };
    }));

    return reply.send(result);
  });

  // GET /affiliates/my-stats — resumo financeiro do afiliado
  // Query param: filter = 'all' | 'own' | 'affiliate' (default: 'all')
  // Query param: startDate, endDate (YYYY-MM-DD) — filtro de data
  app.get('/my-stats', { preHandler: [authenticate] }, async (req, reply) => {
    const { filter = 'all', startDate, endDate } = req.query as { filter?: string; startDate?: string; endDate?: string };

    const dateFilter: any = {};
    if (startDate) dateFilter.gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate)   dateFilter.lte = new Date(`${endDate}T23:59:59.999Z`);
    const hasDateFilter = !!(startDate || endDate);

    // Buscar producer record e flag canCreateProducts
    const [producer, affiliateRec] = await Promise.all([
      prisma.producer.findUnique({ where: { userId: req.user.sub } }),
      prisma.affiliate.findUnique({ where: { userId: req.user.sub }, select: { canCreateProducts: true } }),
    ]);

    // Montar condições de pedidos por filtro
    const dtWhere = hasDateFilter ? { approvedAt: dateFilter } : {};
    const orderWhereAffiliate = { affiliate: { userId: req.user.sub }, status: 'APPROVED' as const, ...dtWhere };
    const orderWhereOwn       = producer
      ? { offer: { product: { producerId: producer.id } }, status: 'APPROVED' as const, affiliateId: null, ...dtWhere }
      : null;

    const orderWhere =
      filter === 'affiliate' ? orderWhereAffiliate :
      filter === 'own'       ? (orderWhereOwn ?? { id: 'none' }) :
      // 'all' — afiliações + produtos próprios
      producer
        ? { status: 'APPROVED' as const, ...dtWhere, OR: [
            { affiliate: { userId: req.user.sub } },
            { offer: { product: { producerId: producer.id } } },
          ]}
        : orderWhereAffiliate;

    // Filtro de reembolsos/chargebacks para o afiliado
    const refundWhere = { affiliate: { userId: req.user.sub as string } };

    const [available, pending, totalClicks, totalConversions, volume,
           refundAgg, chargebackCount, pendingRefundCount] = await Promise.all([
      prisma.splitRecord.aggregate({
        where: { recipientId: req.user.sub, recipientType: { in: ['AFFILIATE', 'PRODUCER'] }, status: 'PAID' },
        _sum : { amountCents: true },
      }),
      prisma.splitRecord.aggregate({
        where: { recipientId: req.user.sub, recipientType: { in: ['AFFILIATE', 'PRODUCER'] }, status: 'PENDING' },
        _sum : { amountCents: true },
      }),
      prisma.affiliateTracking.count({
        where: { affiliate: { userId: req.user.sub } },
      }),
      prisma.order.count({ where: orderWhere }),
      prisma.order.aggregate({
        where: orderWhere,
        _sum : { amountCents: true },
      }),
      prisma.order.aggregate({
        where : { ...refundWhere, status: 'REFUNDED' },
        _sum  : { amountCents: true },
        _count: true,
      }),
      prisma.order.count({ where: { ...refundWhere, status: 'CHARGEBACK' } }),
      // Solicitações pendentes de análise manual (gateway falhou)
      prisma.order.count({
        where: {
          ...refundWhere,
          status  : 'PENDING',
          metadata: { path: ['refundRequest'], not: 'undefined' },
        },
      }),
    ]);

    const withdrawn = await prisma.withdrawal.aggregate({
      where: { userId: req.user.sub, status: { in: ['PAID', 'PROCESSING'] } },
      _sum : { amountCents: true },
    });

    const paidCents      = available._sum.amountCents || 0;
    const withdrawnCents = withdrawn._sum.amountCents || 0;
    const volumeCents    = volume._sum.amountCents    || 0;

    const TIERS = [
      { name: 'Bronze',   min: 0,        max: 2000000,  next: 2000000  },
      { name: 'Prata',    min: 2000000,  max: 5000000,  next: 5000000  },
      { name: 'Ouro',     min: 5000000,  max: 10000000, next: 10000000 },
      { name: 'Diamante', min: 10000000, max: Infinity, next: null     },
    ];

    const currentTier = [...TIERS].reverse().find(t => volumeCents >= t.min) || TIERS[0];
    const nextGoal    = currentTier.next;
    const tierProgress = nextGoal
      ? Math.min(100, Math.round(((volumeCents - currentTier.min) / (nextGoal - currentTier.min)) * 100))
      : 100;

    const refundCount       = refundAgg._count;
    const refundAmountCents = refundAgg._sum.amountCents ?? 0;
    const totalFinalized    = totalConversions + refundCount + chargebackCount;
    const refundRate        = totalFinalized > 0
      ? Math.round(((refundCount + chargebackCount) / totalFinalized) * 10000) / 100
      : 0;

    return reply.send({
      availableCents    : Math.max(0, paidCents - withdrawnCents),
      pendingCents      : pending._sum.amountCents || 0,
      totalClicks,
      totalConversions,
      conversionRate    : totalClicks > 0 ? ((totalConversions / totalClicks) * 100).toFixed(1) : '0.0',
      volumeCents,
      totalSales        : totalConversions,
      tier              : currentTier.name,
      tierProgress,
      tierNextGoal      : nextGoal,
      canCreateProducts : affiliateRec?.canCreateProducts || false,
      refunds: {
        refundCount,
        refundAmountCents,
        chargebackCount,
        pendingRefundCount,
        refundRate,
      },
    });
  });

  // GET /affiliates/my-chart — receita diária
  // Query params: filter, startDate, endDate
  app.get('/my-chart', { preHandler: [authenticate] }, async (req, reply) => {
    const { filter = 'all', startDate, endDate } = req.query as { filter?: string; startDate?: string; endDate?: string };

    const since = startDate
      ? new Date(`${startDate}T00:00:00.000Z`)
      : (() => { const d = new Date(); d.setDate(d.getDate() - 13); d.setHours(0, 0, 0, 0); return d; })();
    const until = endDate ? new Date(`${endDate}T23:59:59.999Z`) : new Date();

    const createdAtFilter: any = { gte: since };
    if (endDate) createdAtFilter.lte = until;

    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });

    const orderWhereAffiliate = { affiliate: { userId: req.user.sub }, status: 'APPROVED' as const, createdAt: createdAtFilter };
    const orderWhereOwn       = producer
      ? { offer: { product: { producerId: producer.id } }, status: 'APPROVED' as const, createdAt: createdAtFilter, affiliateId: null }
      : null;

    const orderWhere =
      filter === 'affiliate' ? orderWhereAffiliate :
      filter === 'own'       ? (orderWhereOwn ?? { id: 'none' }) :
      producer
        ? { status: 'APPROVED' as const, createdAt: createdAtFilter, OR: [
            { affiliate: { userId: req.user.sub } },
            { offer: { product: { producerId: producer.id } } },
          ]}
        : orderWhereAffiliate;

    const orders = await prisma.order.findMany({
      where : orderWhere,
      select: { amountCents: true, createdAt: true },
    });

    const days: Record<string, { day: string; receita: number; pedidos: number }> = {};
    const totalDays = Math.ceil((until.getTime() - since.getTime()) / 86_400_000) + 1;
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(until);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days[key] = {
        day    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        receita: 0,
        pedidos: 0,
      };
    }

    orders.forEach((o: any) => {
      const key = new Date(o.createdAt).toISOString().slice(0, 10);
      if (days[key]) {
        days[key].receita += o.amountCents;
        days[key].pedidos += 1;
      }
    });

    return reply.send(Object.values(days));
  });

  // GET /affiliates/milestones — marcos de todos os produtores + progresso do afiliado
  // MANTIDO: toda a lógica de agrupamento, progresso e cálculo preservada
  // NOVO: inclui termsAndConditions e isEnrolled em cada milestone
  app.get('/milestones', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub as string;

    const affiliate = await prisma.affiliate.findUnique({ where: { userId } });
    if (!affiliate) return reply.send({ data: [] });

    // Busca todos os milestones agrupados por producerId (User.id do produtor)
    const allMilestones = await prisma.salesMilestone.findMany({
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    if (allMilestones.length === 0) return reply.send({ data: [] });

    // NOVO: busca todos os enrollments do afiliado de uma vez (evita N+1)
    const enrollments = await prisma.milestoneEnrollment.findMany({
      where : { affiliateId: affiliate.id },
      select: { milestoneId: true, acceptedAt: true },
    });
    const enrolledMap = new Map(enrollments.map(e => [e.milestoneId, e.acceptedAt]));

    // Agrupa por producerId
    const byProducer = new Map<string, typeof allMilestones>();
    for (const m of allMilestones) {
      const arr = byProducer.get(m.producerId) ?? [];
      arr.push(m);
      byProducer.set(m.producerId, arr);
    }

    // Para cada produtor, resolve o nome e calcula o progresso do afiliado
    const result = await Promise.all(
      Array.from(byProducer.entries()).map(async ([producerUserId, milestones]) => {
        // Resolve o Producer record para obter o nome e o id (Producer.id)
        const producer = await prisma.producer.findUnique({
          where : { userId: producerUserId },
          select: { id: true, tradeName: true, companyName: true },
        });

        const producerName = producer?.tradeName || producer?.companyName || 'Produtor';
        const producerId   = producer?.id;   // Producer.id para filtrar orders

        const [valueSales, unitSales] = await Promise.all([
          prisma.order.aggregate({
            _sum : { amountCents: true },
            where: {
              affiliateId: affiliate.id,
              status     : 'APPROVED',
              ...(producerId ? { offer: { product: { producerId } } } : {}),
            },
          }),
          prisma.order.count({
            where: {
              affiliateId: affiliate.id,
              status     : 'APPROVED',
              ...(producerId ? { offer: { product: { producerId } } } : {}),
            },
          }),
        ]);

        const totalValueCents = valueSales._sum.amountCents ?? 0;
        const totalUnits      = unitSales;

        const milestonesWithProgress = milestones.map(m => {
          const current    = m.targetType === 'VALUE' ? totalValueCents : totalUnits;
          const percentage = Math.min(100, Math.round((current / m.targetValue) * 100));
          const reached    = current >= m.targetValue;
          // NOVO: enriquece com dados de termos e status de inscrição
          return {
            ...m,
            current,
            percentage,
            reached,
            isEnrolled : enrolledMap.has(m.id),
            acceptedAt : enrolledMap.get(m.id) ?? null,
          };
        });

        return {
          producer  : { id: producerUserId, name: producerName },
          milestones: milestonesWithProgress,
          summary   : { totalValueCents, totalUnits },
        };
      })
    );

    return reply.send({ data: result });
  });

  // GET /affiliates/my-refunds — lista de reembolsos e chargebacks do afiliado
  app.get('/my-refunds', { preHandler: [authenticate] }, async (req, reply) => {
    const { page = '1', limit = '20' } = req.query as { page?: string; limit?: string };
    const skip = (Number(page) - 1) * Number(limit);

    const affiliate = await prisma.affiliate.findUnique({ where: { userId: req.user.sub } });
    if (!affiliate) return reply.send({ data: [], total: 0 });

    const baseWhere = { affiliateId: affiliate.id };

    const [refunded, chargebacks, pending] = await Promise.all([
      prisma.order.findMany({
        where  : { ...baseWhere, status: 'REFUNDED' },
        orderBy: { updatedAt: 'desc' },
        skip, take: Number(limit),
        include: { offer: { include: { product: { select: { name: true } } } } },
      }),
      prisma.order.findMany({
        where  : { ...baseWhere, status: 'CHARGEBACK' },
        orderBy: { updatedAt: 'desc' },
        take   : Number(limit),
        include: { offer: { include: { product: { select: { name: true } } } } },
      }),
      prisma.order.findMany({
        where  : { ...baseWhere, status: 'PENDING', metadata: { path: ['refundRequest'], not: 'undefined' } },
        orderBy: { updatedAt: 'desc' },
        take   : Number(limit),
        include: { offer: { include: { product: { select: { name: true } } } } },
      }),
    ]);

    const allOrders = [
      ...refunded.map((o: any)   => ({ ...o, displayStatus: 'REFUNDED'  })),
      ...chargebacks.map((o: any) => ({ ...o, displayStatus: 'CHARGEBACK' })),
      ...pending.map((o: any)     => ({ ...o, displayStatus: 'PENDING_REFUND' })),
    ].sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const total = refunded.length + chargebacks.length + pending.length;
    return reply.send({ data: allOrders, total });
  });

  // POST /affiliates/track — registrar clique (chamado pelo checkout)
  app.post('/track', async (req, reply) => {
    const { affiliateCode, offerId } = z.object({
      affiliateCode: z.string(),
      offerId      : z.string(),
    }).parse(req.body);

    const affiliate = await prisma.affiliate.findUnique({ where: { code: affiliateCode } });
    if (!affiliate) return reply.status(404).send({ message: 'Afiliado não encontrado' });

    await prisma.affiliateTracking.create({
      data: {
        affiliateId: affiliate.id,
        offerId,
        ip        : req.ip,
        userAgent : req.headers['user-agent'] || '',
      },
    });

    return reply.send({ ok: true });
  });
}