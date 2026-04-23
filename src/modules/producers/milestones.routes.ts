import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { AppError } from '../../shared/errors/AppError';

// Paleta de cores padrão para atribuição automática
const AUTO_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6',
];

function pickAutoColor(existingColors: string[]): string {
  const unused = AUTO_COLORS.filter(c => !existingColors.includes(c));
  if (unused.length > 0) return unused[0];
  return AUTO_COLORS[Math.floor(Math.random() * AUTO_COLORS.length)];
}

// MANTIDO: schema original preservado integralmente
// NOVO: campo termsAndConditions adicionado (opcional)
const milestoneSchema = z.object({
  name              : z.string().min(1).max(80),
  color             : z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  targetType        : z.enum(['VALUE', 'UNITS']).default('VALUE'),
  targetValue       : z.number().int().min(1),
  reward            : z.string().min(1).max(2000),
  position          : z.number().int().min(0).optional(),
  termsAndConditions: z.string().max(10000).optional().nullable(),
  // Aceite obrigatório na criação (opcional na edição)
  acceptanceText    : z.string().max(500).optional(),
  acceptanceCpf     : z.string().max(20).optional(),
});

// Normaliza para comparação (remove acentos, pontuação, caixa)
function normalizeAcceptance(s: string): string {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export const milestoneRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /producers/milestones ─────────────────────────────────
  // MANTIDO: lógica de progresso e cálculo preservados integralmente
  app.get('/', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;

    const milestones = await prisma.salesMilestone.findMany({
      where  : { producerId: userId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    // Resolve Producer record ID (Product.producerId stores Producer.id, not User.id)
    const producerRecord = await prisma.producer.findUnique({ where: { userId }, select: { id: true } });
    const producerRecordId = producerRecord?.id ?? userId;

    // Calcula progresso: soma de vendas APPROVED dos produtos do produtor
    const [valueSales, unitSales] = await Promise.all([
      prisma.order.aggregate({
        _sum : { amountCents: true },
        where: {
          status: 'APPROVED',
          offer : { product: { producerId: producerRecordId } },
        },
      }),
      prisma.order.count({
        where: {
          status: 'APPROVED',
          offer : { product: { producerId: producerRecordId } },
        },
      }),
    ]);

    const totalValueCents = valueSales._sum.amountCents ?? 0;
    const totalUnits      = unitSales;

    const data = milestones.map(m => {
      const current    = m.targetType === 'VALUE' ? totalValueCents : totalUnits;
      const percentage = Math.min(100, Math.round((current / m.targetValue) * 100));
      const reached    = current >= m.targetValue;
      return { ...m, current, percentage, reached };
    });

    return reply.send({
      data,
      summary: { totalValueCents, totalUnits },
    });
  });

  // ── POST /producers/milestones ────────────────────────────────
  // MANTIDO: lógica de cor automática e posição automática preservadas
  // NOVO: persiste termsAndConditions
  app.post('/', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;
    const body   = milestoneSchema.parse(req.body);

    // ── Exige aceite dos termos da plataforma ──
    if (!body.acceptanceText || !body.acceptanceCpf) {
      throw new AppError('É obrigatório aceitar os termos de responsabilidade para criar um marco.', 422);
    }

    const user = await prisma.user.findUnique({
      where : { id: userId },
      select: { name: true, document: true },
    });
    if (!user) throw new AppError('Usuário não encontrado', 404);

    const userDoc = (user.document || '').replace(/\D/g, '');
    const typedDoc = body.acceptanceCpf.replace(/\D/g, '');
    if (!userDoc || userDoc !== typedDoc) {
      throw new AppError('O CPF/CNPJ informado no aceite não confere com o cadastrado no perfil.', 422);
    }

    const expectedPhrase = `EU ${user.name} PORTADOR DO CPF ${userDoc} ACEITO OS TERMOS`;
    const normalizedTyped = normalizeAcceptance(body.acceptanceText);
    const normalizedExpected = normalizeAcceptance(expectedPhrase);
    if (!normalizedTyped.includes(normalizedExpected)) {
      throw new AppError(
        `A frase de aceite não confere. Digite exatamente: "EU, ${user.name}, PORTADOR DO CPF ${userDoc}, ACEITO OS TERMOS"`,
        422,
      );
    }

    // Cor automática se não fornecida
    let color = body.color;
    if (!color) {
      const existing = await prisma.salesMilestone.findMany({
        where : { producerId: userId },
        select: { color: true },
      });
      color = pickAutoColor(existing.map(m => m.color));
    }

    // Posição padrão = último + 1
    let position = body.position;
    if (position === undefined) {
      const last = await prisma.salesMilestone.findFirst({
        where  : { producerId: userId },
        orderBy: { position: 'desc' },
        select : { position: true },
      });
      position = (last?.position ?? -1) + 1;
    }

    const milestone = await prisma.salesMilestone.create({
      data: {
        producerId        : userId,
        name              : body.name,
        color,
        targetType        : body.targetType,
        targetValue       : body.targetValue,
        reward            : body.reward,
        position,
        termsAndConditions: body.termsAndConditions ?? null,
        producerAcceptanceText: body.acceptanceText,
        producerAcceptanceCpf : userDoc,
        producerAcceptanceIp  : req.ip,
        producerAcceptedAt    : new Date(),
      },
    });

    return reply.status(201).send(milestone);
  });

  // ── PUT /producers/milestones/:id ─────────────────────────────
  // MANTIDO: toda a lógica de atualização parcial preservada
  // NOVO: permite atualizar termsAndConditions
  app.put('/:id', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;
    const { id } = req.params as { id: string };
    const body   = milestoneSchema.partial().parse(req.body);

    const milestone = await prisma.salesMilestone.findFirst({
      where: { id, producerId: userId },
    });
    if (!milestone) throw new AppError('Marco não encontrado', 404);

    // Cor automática se explicitamente enviada como null/vazia
    let color = body.color ?? undefined;
    if (body.color === null as any || body.color === '') {
      const existing = await prisma.salesMilestone.findMany({
        where : { producerId: userId, id: { not: id } },
        select: { color: true },
      });
      color = pickAutoColor(existing.map(m => m.color));
    }

    const updated = await prisma.salesMilestone.update({
      where: { id },
      data : {
        ...(body.name               !== undefined && { name              : body.name }),
        ...(color                   !== undefined && { color }),
        ...(body.targetType         !== undefined && { targetType        : body.targetType }),
        ...(body.targetValue        !== undefined && { targetValue       : body.targetValue }),
        ...(body.reward             !== undefined && { reward            : body.reward }),
        ...(body.position           !== undefined && { position          : body.position }),
        ...(body.termsAndConditions !== undefined && { termsAndConditions: body.termsAndConditions ?? null }), // NOVO
      },
    });

    return reply.send(updated);
  });

  // ── DELETE /producers/milestones/:id ──────────────────────────
  // MANTIDO: preservado integralmente
  app.delete('/:id', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;
    const { id } = req.params as { id: string };

    const milestone = await prisma.salesMilestone.findFirst({
      where: { id, producerId: userId },
    });
    if (!milestone) throw new AppError('Marco não encontrado', 404);

    await prisma.salesMilestone.delete({ where: { id } });

    return reply.send({ ok: true });
  });

  // ── PUT /producers/milestones/reorder ─────────────────────────
  // MANTIDO: preservado integralmente
  app.put('/reorder', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;
    const { items } = z.object({
      items: z.array(z.object({ id: z.string(), position: z.number().int() })),
    }).parse(req.body);

    await prisma.$transaction(
      items.map(({ id, position }) =>
        prisma.salesMilestone.updateMany({
          where: { id, producerId: userId },
          data : { position },
        })
      )
    );

    return reply.send({ ok: true });
  });

  // ── POST /producers/milestones/:id/join ───────────────────────
  // NOVO: afiliado aceita termos e ingressa no marco
  app.post('/:id/join', { preHandler: [authenticate, requireRole('AFFILIATE')] }, async (req, reply) => {
    const userId = (req.user as any).sub as string;
    const { id } = req.params as { id: string };

    // Valida que o marco existe
    const milestone = await prisma.salesMilestone.findUnique({ where: { id } });
    if (!milestone) throw new AppError('Marco não encontrado', 404);

    // Resolve o Affiliate record do usuário logado
    const affiliate = await prisma.affiliate.findUnique({ where: { userId } });
    if (!affiliate) throw new AppError('Perfil de afiliado não encontrado', 404);

    // Cria o enrollment (ignora se já existe — upsert pelo unique constraint)
    await prisma.milestoneEnrollment.upsert({
      where : { milestoneId_affiliateId: { milestoneId: id, affiliateId: affiliate.id } },
      create: { milestoneId: id, affiliateId: affiliate.id },
      update: {},   // já inscrito — não faz nada
    });

    return reply.status(201).send({ ok: true });
  });

  // ── GET /producers/milestones/:id/enrollment ──────────────────
  // NOVO: retorna se o afiliado logado está inscrito no marco
  app.get('/:id/enrollment', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub as string;
    const { id } = req.params as { id: string };

    const affiliate = await prisma.affiliate.findUnique({ where: { userId } });
    if (!affiliate) return reply.send({ enrolled: false });

    const enrollment = await prisma.milestoneEnrollment.findUnique({
      where: { milestoneId_affiliateId: { milestoneId: id, affiliateId: affiliate.id } },
    });

    return reply.send({ enrolled: !!enrollment, acceptedAt: enrollment?.acceptedAt ?? null });
  });
};
