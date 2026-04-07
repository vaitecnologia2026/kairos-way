import { prisma } from '../../shared/utils/prisma';
import { calcBps, validateSplitSum } from '../../shared/utils/money';
import { ValidationError, NotFoundError } from '../../shared/errors/AppError';
import { RecipientType } from '@prisma/client';

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
      throw new ValidationError(
        `Soma dos splits deve ser 100% (10000 bps). Atual: ${total} bps (${total / 100}%)`
      );
    }

    // Validar que cada bps é positivo
    for (const split of splits) {
      if (split.basisPoints <= 0) {
        throw new ValidationError('Cada split deve ter basis points positivo');
      }
    }

    // Inativar splits anteriores (NUNCA deletar)
    await prisma.splitRule.updateMany({
      where: { offerId, isActive: true },
      data: { isActive: false },
    });

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
      throw new ValidationError(`Oferta ${offerId} não tem splits configurados`);
    }

    // Validar soma
    const totalBps = rules.reduce((sum, r) => sum + r.basisPoints, 0);
    if (totalBps !== 10000) {
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

    return calculations;
  }

  /**
   * Salvar registros de split após pagamento aprovado
   * Registros são IMUTÁVEIS
   */
  async saveSplitRecords(orderId: string, splits: SplitCalculation[]): Promise<void> {
    await prisma.splitRecord.createMany({
      data: splits.map((s) => ({
        orderId,
        splitRuleId: s.splitRuleId,
        recipientType: s.recipientType,
        recipientId: s.recipientId,
        amountCents: s.amountCents,
        status: 'PENDING',
      })),
    });
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

  /** Saldo disponível de um usuário (splits pagos - saques) */
  async getUserBalance(userId: string): Promise<{
    availableCents : number;
    pendingCents   : number;
    totalCents     : number;
    withdrawnCents : number;
  }> {
    const [paid, pending, withdrawn] = await Promise.all([
      // Splits já pagos para este usuário
      prisma.splitRecord.aggregate({
        where: { recipientId: userId, status: 'PAID' },
        _sum : { amountCents: true },
      }),
      // Splits ainda pendentes
      prisma.splitRecord.aggregate({
        where: { recipientId: userId, status: 'PENDING' },
        _sum : { amountCents: true },
      }),
      // Saques já pagos ou em processamento
      prisma.withdrawal.aggregate({
        where: { userId, status: { in: ['PAID', 'PROCESSING'] } },
        _sum : { amountCents: true },
      }),
    ]);

    const totalPaid      = paid._sum.amountCents      || 0;
    const totalPending   = pending._sum.amountCents   || 0;
    const totalWithdrawn = withdrawn._sum.amountCents || 0;

    // availableCents = ganhos PAID - já sacados
    // pendingCents   = ganhos ainda não confirmados (splits PENDING)
    // totalCents     = tudo que o produtor ganhou (PAID + PENDING)
    // withdrawnCents = total já sacado

    return {
      availableCents: Math.max(0, totalPaid - totalWithdrawn),
      pendingCents  : totalPending,
      totalCents    : totalPaid + totalPending,
      withdrawnCents: totalWithdrawn,
    };
  }
}