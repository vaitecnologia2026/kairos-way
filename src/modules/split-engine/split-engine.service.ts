import { prisma } from '../../shared/utils/prisma';
import { calcBps, validateSplitSum } from '../../shared/utils/money';
import { ValidationError, NotFoundError } from '../../shared/errors/AppError';
import { RecipientType } from '@prisma/client';
import { logger } from '../../shared/utils/logger';

export interface SplitInput {
  recipientType: RecipientType;
  recipientId?: string;
  basisPoints: number;
  description?: string;
}

export interface SplitCalculation {
  splitRuleId: string;
  recipientType: RecipientType;
  recipientId: string | null;
  amountCents: number;
  basisPoints: number;
  percentage: number;
}

/**
 * SPLIT ENGINE — Coração financeiro do sistema
 * 
 * REGRAS CRÍTICAS:
 * - Valores sempre em CENTAVOS
 * - Splits em BASIS POINTS (1% = 100 bps)
 * - Soma DEVE ser exatamente 10000 bps (100%)
 * - Registros são IMUTÁVEIS — inativar e criar novo
 */
export class SplitEngineService {
  /**
   * Configurar splits de uma oferta
   * Inativa splits anteriores e cria novos
   */
  async configureSplits(offerId: string, splits: SplitInput[]): Promise<void> {
    const offer = await prisma.offer.findUnique({ where: { id: offerId } });
    if (!offer) throw new NotFoundError('Oferta');

    // Validar soma = 10000 bps (100%)
    const total = splits.reduce((sum, s) => sum + s.basisPoints, 0);
    if (total !== 10000) {
      logger.error({ offerId, totalBps: total }, 'SplitEngine: soma dos splits inválida');
      throw new ValidationError(
        `Soma dos splits deve ser 100% (10000 bps). Atual: ${total} bps (${total / 100}%)`
      );
    }

    // Validar que cada bps é positivo
    for (const split of splits) {
      if (split.basisPoints <= 0) {
        logger.error({ offerId, split }, 'SplitEngine: basis points inválido');
        throw new ValidationError('Cada split deve ter basis points positivo');
      }
    }

    // Inativar splits anteriores (NUNCA deletar)
    const { count: inactivated } = await prisma.splitRule.updateMany({
      where: { offerId, isActive: true },
      data: { isActive: false },
    });
    logger.info({ offerId, inactivated }, 'SplitEngine: splits anteriores inativados');

    // Criar novos splits
    await prisma.splitRule.createMany({
      data: splits.map((s) => ({
        offerId,
        recipientType: s.recipientType,
        recipientId: s.recipientId || null,
        basisPoints: s.basisPoints,
        description: s.description,
        isActive: true,
      })),
    });
    logger.info({ offerId, count: splits.length, splits: splits.map(s => ({ type: s.recipientType, bps: s.basisPoints })) }, 'SplitEngine: novos splits configurados');
  }

  /**
   * Calcular splits para um pagamento
   * Retorna array com valor exato para cada destinatário
   */
  async calculate(offerId: string, amountCents: number): Promise<SplitCalculation[]> {
    const rules = await prisma.splitRule.findMany({
      where: { offerId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    if (rules.length === 0) {
      logger.error({ offerId }, 'SplitEngine: calculate — oferta sem splits configurados');
      throw new ValidationError(`Oferta ${offerId} não tem splits configurados`);
    }

    // Validar soma
    const totalBps = rules.reduce((sum, r) => sum + r.basisPoints, 0);
    if (totalBps !== 10000) {
      logger.error({ offerId, totalBps }, 'SplitEngine: calculate — soma dos splits corrompida');
      throw new ValidationError(
        `Split inválido: soma = ${totalBps} bps. Esperado: 10000 bps`
      );
    }

    const calculations: SplitCalculation[] = [];
    let allocated = 0;

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      let amount: number;

      if (i === rules.length - 1) {
        // Último recebedor pega o resto (evitar perda de centavo por arredondamento)
        amount = amountCents - allocated;
      } else {
        amount = calcBps(amountCents, rule.basisPoints);
      }

      allocated += amount;

      calculations.push({
        splitRuleId: rule.id,
        recipientType: rule.recipientType,
        recipientId: rule.recipientId,
        amountCents: amount,
        basisPoints: rule.basisPoints,
        percentage: rule.basisPoints / 100,
      });
    }

    logger.info(
      { offerId, amountCents, splitCount: calculations.length, total: calculations.reduce((s, c) => s + c.amountCents, 0) },
      'SplitEngine: cálculo concluído'
    );
    return calculations;
  }

  /**
   * Salvar registros de split após pagamento aprovado
   * Registros são IMUTÁVEIS
   */
  async saveSplitRecords(orderId: string, splits: SplitCalculation[], tx?: any): Promise<void> {
    const db = tx || prisma;

    // Resolver recipientId do PRODUTOR automaticamente se não definido
    const order = await db.order.findUnique({
      where  : { id: orderId },
      include: { offer: { include: { product: { include: { producer: true } } } } },
    });

    const producerUserId = order?.offer?.product?.producer?.userId;

    // Calcula data de liberação por recipient (respeita customReleaseDays)
    const { calcUserReleaseDate } = await import('../../shared/services/release.service');
    const approvedAt = order?.approvedAt || new Date();

    const releaseCache = new Map<string, Date>();
    const resolveAvailableAt = async (recipientId: string | null): Promise<Date | null> => {
      if (!recipientId) return null;
      if (releaseCache.has(recipientId)) return releaseCache.get(recipientId)!;
      try {
        const { availableAt } = await calcUserReleaseDate({
          userId       : recipientId,
          paymentMethod: order?.paymentMethod ?? null,
          approvedAt,
        });
        releaseCache.set(recipientId, availableAt);
        return availableAt;
      } catch {
        return null;
      }
    };

    const data: any[] = [];
    for (const s of splits) {
      const recipientId = s.recipientId
        ? s.recipientId
        : s.recipientType === 'PRODUCER'
          ? (producerUserId || null)
          : null;

      // Plataforma não tem prazo de liberação — é imediato
      const availableAt = s.recipientType === 'PLATFORM'
        ? approvedAt
        : await resolveAvailableAt(recipientId);

      data.push({
        orderId,
        splitRuleId  : s.splitRuleId,
        recipientType: s.recipientType,
        recipientId,
        amountCents  : s.amountCents,
        status       : 'PENDING',
        availableAt,
      });
    }

    await db.splitRecord.createMany({ data });
    logger.info({ orderId, count: splits.length }, 'SplitEngine: registros de split salvos');
  }

  /** Listar splits de uma oferta */
  async getOfferSplits(offerId: string) {
    return prisma.splitRule.findMany({
      where: { offerId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Histórico de splits de um pedido */
  async getOrderSplits(orderId: string) {
    return prisma.splitRecord.findMany({
      where: { orderId },
      include: { splitRule: true },
    });
  }

  /**
   * Saldo de um usuário considerando prazos de liberação:
   *   - availableCents: splits já liberados (availableAt <= agora ou PAID) menos saques
   *   - pendingCents:   splits ainda não liberados (availableAt > agora)
   *   - totalCents:     soma liberada até agora
   */
  async getUserBalance(userId: string): Promise<{
    availableCents: number;
    pendingCents  : number;
    totalCents    : number;
  }> {
    const now = new Date();

    // Liberado = PAID OU (PENDING e availableAt <= now) OU (availableAt == null)
    // Não liberado = availableAt > now
    const [released, notReleased, withdrawals] = await Promise.all([
      prisma.splitRecord.aggregate({
        where: {
          recipientId: userId,
          status     : { in: ['PAID', 'PENDING'] },
          OR: [
            { availableAt: null },
            { availableAt: { lte: now } },
          ],
        },
        _sum: { amountCents: true },
      }),
      prisma.splitRecord.aggregate({
        where: {
          recipientId: userId,
          status     : 'PENDING',
          availableAt: { gt: now },
        },
        _sum: { amountCents: true },
      }),
      prisma.withdrawal.aggregate({
        where: { userId, status: { in: ['PAID', 'PROCESSING'] } },
        _sum : { amountCents: true },
      }),
    ]);

    const totalReleased   = released._sum.amountCents || 0;
    const totalPending    = notReleased._sum.amountCents || 0;
    const totalWithdrawn  = withdrawals._sum.amountCents || 0;
    const availableCents  = Math.max(0, totalReleased - totalWithdrawn);

    return {
      availableCents,
      pendingCents: totalPending,
      totalCents  : totalReleased,
    };
  }
}