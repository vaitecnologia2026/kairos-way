import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { AuditService } from '../audit/audit.service';
import { logger } from '../../shared/utils/logger';
import { whatsAppService } from '../../shared/services/whatsapp.service';
import { Resend } from 'resend';

const audit = new AuditService();

export async function adminRoutes(app: FastifyInstance) {

  // GET /admin/dashboard
  app.get('/dashboard', { preHandler: [authenticate, requireRole('ADMIN', 'STAFF')] }, async (req, reply) => {
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };

    const dateFilter: any = {};
    if (startDate) dateFilter.gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate)   dateFilter.lte = new Date(`${endDate}T23:59:59.999Z`);

    const orderWhere: any = { status: 'APPROVED' };
    if (startDate || endDate) orderWhere.approvedAt = dateFilter;

    const [totalProducers, pendingKyc, totalOrders, revenue, activeSubscriptions] = await Promise.all([
      prisma.producer.count({ where: { isActive: true } }),
      prisma.producer.count({ where: { kycStatus: 'PENDING' } }),
      prisma.order.count({ where: orderWhere }),
      prisma.order.aggregate({ where: orderWhere, _sum: { amountCents: true } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    ]);

    return reply.send({
      totalProducers, pendingKyc, totalOrders,
      totalRevenueCents: revenue._sum.amountCents || 0,
      activeSubscriptions,
    });
  });

  // GET /admin/users — listar todos os usuários
  app.get('/users', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const { page = '1', limit = '50', role } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);
    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where: { role: role || undefined, deletedAt: null },
        select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true, lastLoginAt: true },
        skip, take: Number(limit), orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where: { role: role || undefined, deletedAt: null } }),
    ]);
    return reply.send({ data, total });
  });

  // POST /admin/staff — criar colaborador
  app.post('/staff', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(3),
      email: z.string().email(),
      staffRole: z.enum(['FINANCIAL', 'SUPPORT', 'MODERATOR']),
    }).parse(req.body);

    const bcrypt = await import('bcryptjs');
    const tempPass = Math.random().toString(36).slice(-12);
    const user = await prisma.user.create({
      data: {
        name: body.name, email: body.email,
        passwordHash: await bcrypt.hash(tempPass, 12),
        role: 'STAFF', isActive: true,
        staffMember: { create: { staffRole: body.staffRole, invitedBy: req.user.sub } },
      },
    });

    await audit.log({ userId: req.user.sub, action: 'STAFF_CREATED', details: { userId: user.id, staffRole: body.staffRole }, level: 'HIGH' });
    return reply.status(201).send({ userId: user.id, tempPassword: tempPass });
  });

  // GET /admin/producers/pending — leads aguardando aprovação
  app.get('/producers/pending', { preHandler: [authenticate, requireRole('ADMIN', 'STAFF')] }, async (_req, reply) => {
    const producers = await prisma.producer.findMany({
      where: { kycStatus: { in: ['PENDING', 'DOCUMENTS_SENT'] } },
      include: {
        user: { select: { name: true, email: true, phone: true, document: true, createdAt: true } },
        kycDocuments: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send(producers);
  });

  // GET /admin/settings — configurações da plataforma (persistidas no banco)
  app.get('/settings', { preHandler: [authenticate, requireRole('ADMIN')] }, async (_req, reply) => {
    const rows = await prisma.platformConfig.findMany();
    const settings: Record<string, any> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return reply.send(settings);
  });

  // POST /admin/settings — salvar configurações (merge parcial)
  app.post('/settings', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const body = req.body as Record<string, any>;

    for (const [key, value] of Object.entries(body)) {
      await prisma.platformConfig.upsert({
        where : { key },
        create: { key, value: value as any },
        update: { value: value as any },
      });
    }

    await audit.log({ userId: req.user.sub, action: 'SETTINGS_UPDATED', details: Object.keys(body), level: 'HIGH' });
    return reply.send({ message: 'Configurações salvas' });
  });

  // PATCH /admin/settings — alias do POST (frontend usa PATCH)
  app.patch('/settings', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const body = req.body as Record<string, any>;

    for (const [key, value] of Object.entries(body)) {
      await prisma.platformConfig.upsert({
        where : { key },
        create: { key, value: value as any },
        update: { value: value as any },
      });
    }

    await audit.log({ userId: req.user.sub, action: 'SETTINGS_UPDATED', details: Object.keys(body), level: 'HIGH' });
    return reply.send({ message: 'Configurações salvas' });
  });

  // ══════════════════════════════════════════════════════════════════
  // TAXAS E COMISSÕES (v2) — estrutura oficial
  // ══════════════════════════════════════════════════════════════════
  // 4 métodos: PIX, BOLETO, CARD, WITHDRAWAL
  // Cada taxa: { platform: {bps?, cents?}, acquirer: {bps?, cents?} }
  //   → bps (% em basis points) e cents (R$ fixo) podem coexistir
  //
  // Taxa personalizada por usuário:
  //   Producer.customFees / Affiliate.customFees = Partial<Record<Method, FeePart>>
  //   Se customFees[method] existe → substitui a taxa da plataforma para esse método
  //   Caso contrário → herda taxa geral
  //
  // A taxa do adquirente NÃO é customizável por usuário — vem só da config geral.
  //
  // Snapshot: cada Order salva em appliedFees a taxa aplicada no momento da venda.

  const FEE_METHODS_LOCAL = ['PIX', 'BOLETO', 'CARD', 'WITHDRAWAL'] as const;

  const feePartSchema = z.object({
    bps  : z.number().int().min(0).optional(),
    cents: z.number().int().min(0).optional(),
  });

  const feeConfigSchema = z.object({
    platform: feePartSchema,
    acquirer: feePartSchema,
  });

  const EMPTY_FEE = { platform: {}, acquirer: {} };

  // GET /admin/platform-fee — taxa PIX padrão (compat legado, usa PIX como default visual)
  app.get('/platform-fee', { preHandler: [authenticate] }, async (req, reply) => {
    const { resolveEffectiveFee } = await import('../../shared/services/fees.service');
    const pix = await resolveEffectiveFee(req.user.sub, 'PIX');
    const bps = pix.platform.bps ?? 0;
    return reply.send({
      platformBps: bps,
      platformPct: bps / 100,
      isCustom   : pix.isCustom,
    });
  });

  // GET /admin/fees — taxa geral (4 métodos)
  app.get('/fees', { preHandler: [authenticate, requireRole('ADMIN')] }, async (_req, reply) => {
    const rows = await prisma.platformConfig.findMany({
      where: { key: { startsWith: 'fees.' } },
    });
    const byKey = new Map<string, any>(rows.map(r => [r.key, r.value]));
    const fees: Record<string, any> = {};
    for (const m of FEE_METHODS_LOCAL) {
      const raw = byKey.get(`fees.${m}`);
      fees[m] = raw && raw.platform !== undefined ? raw : EMPTY_FEE;
    }
    return reply.send({ fees });
  });

  // POST /admin/fees — bulk update
  app.post('/fees', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const body = z.object({
      fees: z.record(z.enum(FEE_METHODS_LOCAL), feeConfigSchema),
    }).parse(req.body);

    const ops: any[] = [];
    for (const [method, cfg] of Object.entries(body.fees)) {
      const key = `fees.${method}`;
      ops.push(prisma.platformConfig.upsert({
        where : { key },
        create: { key, value: cfg as any },
        update: { value: cfg as any },
      }));
    }
    await Promise.all(ops);

    await audit.log({
      userId : req.user.sub,
      action : 'FEES_UPDATED',
      details: body as any,
      level  : 'HIGH',
    });

    logger.info({ methods: Object.keys(body.fees), by: req.user.sub }, 'Admin: taxas atualizadas');
    return reply.send({ message: 'Taxas atualizadas' });
  });

  // GET /admin/fees/users — usuários + taxas personalizadas (por método)
  app.get('/fees/users', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const { q = '', onlyCustom, role } = req.query as { q?: string; onlyCustom?: string; role?: string };
    const search = q.trim();
    const onlyCustomFlag = onlyCustom === '1' || onlyCustom === 'true';
    const roleFilter = role === 'PRODUCER' || role === 'AFFILIATE' ? role : null;

    const userFilter = search
      ? { OR: [
          { name : { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ]}
      : {};

    const wantProducers  = roleFilter === null || roleFilter === 'PRODUCER';
    const wantAffiliates = roleFilter === null || roleFilter === 'AFFILIATE';

    const [producers, affiliates] = await Promise.all([
      wantProducers
        ? prisma.producer.findMany({
            where  : onlyCustomFlag
              ? { customFees: { not: null as any }, user: userFilter }
              : { user: userFilter },
            include: { user: { select: { id: true, name: true, email: true } } },
            take   : 50,
          })
        : Promise.resolve([]),
      wantAffiliates
        ? prisma.affiliate.findMany({
            where  : onlyCustomFlag
              ? { customFees: { not: null as any }, user: userFilter }
              : { user: userFilter },
            include: { user: { select: { id: true, name: true, email: true } } },
            take   : 50,
          })
        : Promise.resolve([]),
    ]);

    const rows = [
      ...producers .map(p => ({ userId: p.userId, name: p.user.name, email: p.user.email, role: 'PRODUCER'  as const, customFees: p.customFees as any })),
      ...affiliates.map(a => ({ userId: a.userId, name: a.user.name, email: a.user.email, role: 'AFFILIATE' as const, customFees: a.customFees as any })),
    ].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    return reply.send({ data: rows, total: rows.length });
  });

  // PUT /admin/fees/users/:userId — taxa personalizada por método (granular)
  app.put('/fees/users/:userId', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = z.object({
      customFees: z.record(z.enum(FEE_METHODS_LOCAL), feePartSchema).nullable(),
    }).parse(req.body);

    const [producer, affiliate] = await Promise.all([
      prisma.producer.findUnique({ where: { userId }, select: { id: true } }),
      prisma.affiliate.findUnique({ where: { userId }, select: { id: true } }),
    ]);

    if (!producer && !affiliate) {
      return reply.status(404).send({ message: 'Usuário não é produtor nem afiliado' });
    }

    // Se customFees for null OU objeto vazio, armazena null (herda tudo da geral)
    const cleaned = body.customFees
      ? Object.fromEntries(Object.entries(body.customFees).filter(([, v]) => v && ((v as any).bps || (v as any).cents)))
      : null;
    const toSave  = cleaned && Object.keys(cleaned).length > 0 ? cleaned : null;

    if (producer)  await prisma.producer .update({ where: { userId }, data: { customFees: toSave as any } });
    if (affiliate) await prisma.affiliate.update({ where: { userId }, data: { customFees: toSave as any } });

    await audit.log({
      userId : req.user.sub,
      action : 'USER_CUSTOM_FEE_SET',
      details: { targetUserId: userId, customFees: toSave },
      level  : 'HIGH',
    });

    return reply.send({ message: toSave === null ? 'Taxa personalizada removida' : 'Taxa personalizada definida' });
  });

  // ── AMBIENTE DE TESTE ──────────────────────────────────────────

  // GET /admin/test/order/:code — busca pedido pelo código (últimos 8 chars do ID)
  app.get('/test/order/:code', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const id = code.toLowerCase();

    const order = await prisma.order.findFirst({
      where: { id: { contains: id } },
      include: {
        offer: {
          include: {
            product: { select: { name: true, digitalUrl: true } },
          },
        },
      },
    });

    if (!order) throw new NotFoundError('Pedido');

    return reply.send({
      id           : order.id,
      status       : order.status,
      customerName : order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone || '',
      paymentMethod: order.paymentMethod,
      amountCents  : order.amountCents,
      productName  : order.offer?.product?.name || '—',
      digitalUrl   : (order.offer?.product as any)?.digitalUrl || null,
    });
  });

  // POST /admin/test/approve — força APPROVED e dispara notificações
  app.post('/test/approve', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { orderId, overrideEmail } = req.body as { orderId: string; overrideEmail?: string };

    const order = await prisma.order.findUnique({
      where  : { id: orderId },
      include: { offer: { include: { product: { include: { producer: true } } } } },
    });

    if (!order) throw new NotFoundError('Pedido');

    // 1. Forçar APPROVED
    await prisma.order.update({
      where: { id: orderId },
      data : { status: 'APPROVED', approvedAt: new Date() },
    });

    // 1b. Criar SplitRecords se ainda não existirem
    try {
      const existingSplits = await prisma.splitRecord.count({ where: { orderId } });
      if (existingSplits === 0 && order.offerId) {
        const rules = await prisma.splitRule.findMany({
          where: { offerId: order.offerId, isActive: true },
          orderBy: { createdAt: 'asc' },
        });
        if (rules.length > 0) {
          // Buscar userId do produtor para resolver recipientId automaticamente
          const producerUserId = order.offer?.product?.producer?.userId || null;
          let allocated = 0;
          const splitData = rules.map((rule: any, i: number) => {
            const amount = i === rules.length - 1
              ? order.amountCents - allocated
              : Math.floor(order.amountCents * rule.basisPoints / 10000);
            allocated += amount;
            const recipientId = rule.recipientId
              ? rule.recipientId
              : rule.recipientType === 'PRODUCER'
                ? producerUserId
                : null;
            return {
              orderId,
              splitRuleId  : rule.id,
              recipientType: rule.recipientType,
              recipientId,
              amountCents  : amount,
              status       : 'PENDING' as const,
            };
          });
          await prisma.splitRecord.createMany({ data: splitData });
        }
      }
      // Split do afiliado
      if (order.affiliateId) {
        const affiliate = await prisma.affiliate.findUnique({ where: { id: order.affiliateId } });
        if (affiliate) {
          const config = await prisma.affiliateConfig.findFirst({
            where: { offerId: order.offerId!, enabled: true },
          });
          if (config && config.commissionBps > 0) {
            const commissionCents = Math.floor(order.amountCents * config.commissionBps / 10000);
            const alreadyHasAffiliateSplit = await prisma.splitRecord.count({
              where: { orderId, recipientType: 'AFFILIATE' },
            });
            if (commissionCents > 0 && alreadyHasAffiliateSplit === 0) {
              const firstRule = await prisma.splitRule.findFirst({
              where: { offerId: order.offerId!, isActive: true },
              orderBy: { createdAt: 'asc' },
              });

              if (firstRule) await prisma.splitRecord.create({
                data: {
                  orderId,
                  splitRuleId  : firstRule.id,
                  recipientType: 'AFFILIATE',
                  recipientId  : affiliate.userId,
                  amountCents  : commissionCents,
                  status       : 'PENDING',
                },
              });
            }
          }
        }
      }
    } catch (splitErr: any) {
      logger.warn({ err: splitErr.message }, 'Admin: split não gerado ao reprocessar pedido');
    }

    const digitalUrl  = (order.offer?.product as any)?.digitalUrl;
    const productName = order.offer?.product?.name || 'Produto';
    const emailDest   = overrideEmail || order.customerEmail;

    const methodLabel: Record<string, string> = {
      PIX        : 'Pix',
      CREDIT_CARD: 'Cartão de crédito',
      BOLETO     : 'Boleto',
    };

    const results: Record<string, any> = { approved: true };

    // 2. Email via Resend
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const emailHtml = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#0055FE;padding:24px;border-radius:12px 12px 0 0;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:20px">Kairos Way</h1>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e4e7">
            <h2 style="margin-top:0">Pagamento confirmado! 🎉</h2>
            <p>Olá, <strong>${order.customerName}</strong>!</p>
            <p>Seu pedido foi aprovado com sucesso.</p>
            <div style="background:#f0f6ff;border-left:4px solid #0055FE;padding:12px 16px;border-radius:4px;margin:16px 0">
              <strong>Produto:</strong> ${productName}<br/>
              <strong>Valor:</strong> R$ ${(order.amountCents / 100).toFixed(2).replace('.', ',')}<br/>
              <strong>Pedido:</strong> #${orderId.slice(-8).toUpperCase()}
            </div>
            ${digitalUrl ? `<a href="${digitalUrl}" style="display:inline-block;background:#0055FE;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">Acessar Produto</a>` : ''}
          </div>
        </div>`;

      const emailRes = await resend.emails.send({
        from   : `${process.env.EMAIL_FROM_NAME || 'Kairos Way'} <${process.env.EMAIL_FROM || 'onboarding@resend.dev'}>`,
        to     : emailDest,
        subject: `Pagamento confirmado — ${productName}`,
        html   : emailHtml,
      });
      results.email = emailRes.error ? `erro: ${emailRes.error.message}` : `ok: ${emailRes.data?.id}`;
    } catch (err: any) {
      results.email = `erro: ${err.message}`;
    }

    // 3. WhatsApp (usa telefone real do pedido, não o email override)
    if (digitalUrl && order.customerPhone) {
      try {
        const method = methodLabel[order.paymentMethod] || order.paymentMethod;
        await whatsAppService.sendPurchaseConfirmation({
          phone        : order.customerPhone,
          customerName : order.customerName,
          productName,
          paymentMethod: order.paymentMethod,
          digitalUrl,
        });
        results.whatsapp = 'ok';
      } catch (err: any) {
        results.whatsapp = `erro: ${err.message}`;
      }
    } else {
      results.whatsapp = 'pulado (sem digitalUrl ou telefone)';
    }

    return reply.send({ message: 'Pedido aprovado', results });
  });
}