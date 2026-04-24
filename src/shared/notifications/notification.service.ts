import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

/**
 * NotificationService — ponto único de criação de notificações do sininho.
 *
 * Motivação: antes tinhamos `prisma.notification.create({ data: { userId, ... } })`
 * espalhado, com `userId` recebido como string crua. Isso levou a bugs silenciosos
 * (ex.: customer.routes.ts passava Product.producerId achando que era User.id,
 * FK violation caía no catch => nenhuma notificação chegava ao sininho).
 *
 * Agora o destinatário é **tipado** via discriminated union. O service resolve
 * o User.id final internamente. Fica impossível passar o ID errado sem TS reclamar.
 */

// ── TIPOS ────────────────────────────────────────────────────────────────

export type NotifRecipient =
  | { kind: 'user';      userId: string }
  | { kind: 'producer';  producerId: string }     // Producer.id → resolve Producer.userId
  | { kind: 'affiliate'; affiliateId: string }    // Affiliate.id → resolve Affiliate.userId
  | { kind: 'admins' };                           // fan-out p/ todos ADMIN/STAFF ativos

/** Enum simples: mantemos só o string mas ao menos documenta e previne typo. */
export const NotifType = {
  // Vendas / comissões
  NEW_SALE            : 'NEW_SALE',
  NEW_COMMISSION      : 'NEW_COMMISSION',
  // Reembolsos
  REFUND_REQUESTED    : 'REFUND_REQUESTED',
  REFUND_PROCESSED    : 'REFUND_PROCESSED',
  COMMISSION_CANCELLED: 'COMMISSION_CANCELLED',
  // KYC
  KYC_DOC_APPROVED    : 'KYC_DOC_APPROVED',
  KYC_DOC_ADJUSTMENT  : 'KYC_DOC_ADJUSTMENT',
  KYC_DOC_REJECTED    : 'KYC_DOC_REJECTED',
  KYC_REVOKED         : 'KYC_REVOKED',
  // Admin
  PRODUCER_PENDING_KYC   : 'PRODUCER_PENDING_KYC',
  AFFILIATE_PENDING      : 'AFFILIATE_PENDING',
  WITHDRAWAL_REQUESTED   : 'WITHDRAWAL_REQUESTED',
  PRODUCT_PENDING_REVIEW : 'PRODUCT_PENDING_REVIEW',
  // Outros
  AFFILIATE_APPROVED  : 'AFFILIATE_APPROVED',
  AFFILIATE_REJECTED  : 'AFFILIATE_REJECTED',
  AFFILIATE_ENROLLED  : 'AFFILIATE_ENROLLED',
  MILESTONE_REACHED   : 'MILESTONE_REACHED',
  WITHDRAWAL_PAID     : 'WITHDRAWAL_PAID',
  CHARGEBACK          : 'CHARGEBACK',
} as const;

export type NotifTypeValue = typeof NotifType[keyof typeof NotifType];

export interface NotifInput {
  recipient: NotifRecipient;
  type     : NotifTypeValue | string;  // aceita string p/ compat, mas prefira NotifType.X
  title    : string;
  body     : string;
  orderId? : string;
}

// ── SERVICE ──────────────────────────────────────────────────────────────

export class NotificationService {
  /**
   * Cria notificação(ões) para o destinatário.
   * NÃO lança — falhas são logadas mas não quebram o fluxo de negócio.
   * Retorna `count` de notificações criadas (0 = destinatário não resolvido).
   */
  async notify(input: NotifInput): Promise<number> {
    const userIds = await this.resolveUserIds(input.recipient);

    if (userIds.length === 0) {
      logger.warn(
        { recipient: input.recipient, type: input.type },
        'notify: destinatário não resolveu para nenhum User — notificação descartada',
      );
      return 0;
    }

    try {
      const result = await prisma.notification.createMany({
        data: userIds.map(userId => ({
          userId,
          type   : input.type,
          title  : input.title,
          body   : input.body,
          orderId: input.orderId,
        })),
      });
      logger.info(
        { type: input.type, count: result.count, kind: input.recipient.kind, orderId: input.orderId },
        'notify: notificação criada',
      );
      return result.count;
    } catch (err: any) {
      // ATENÇÃO: não usar `.catch(() => {})` silencioso. Loga com contexto.
      logger.error(
        { err: err.message, recipient: input.recipient, type: input.type },
        'notify: falha ao persistir notificação',
      );
      return 0;
    }
  }

  /** Helper de conveniência p/ notificar múltiplos destinatários numa chamada. */
  async notifyMany(inputs: NotifInput[]): Promise<number> {
    let total = 0;
    for (const input of inputs) total += await this.notify(input);
    return total;
  }

  /**
   * Resolve o destinatário tipado para lista de User.id válidos.
   * Retorna [] se não achar (nunca lança — deixa o caller seguir o fluxo).
   */
  private async resolveUserIds(r: NotifRecipient): Promise<string[]> {
    switch (r.kind) {
      case 'user':
        return r.userId ? [r.userId] : [];

      case 'producer': {
        const p = await prisma.producer.findUnique({
          where : { id: r.producerId },
          select: { userId: true },
        });
        return p ? [p.userId] : [];
      }

      case 'affiliate': {
        const a = await prisma.affiliate.findUnique({
          where : { id: r.affiliateId },
          select: { userId: true },
        });
        return a ? [a.userId] : [];
      }

      case 'admins': {
        const admins = await prisma.user.findMany({
          where : { role: { in: ['ADMIN', 'STAFF'] }, isActive: true },
          select: { id: true },
        });
        return admins.map(a => a.id);
      }
    }
  }
}

export const notifications = new NotificationService();
