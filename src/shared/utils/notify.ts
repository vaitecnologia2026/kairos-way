import { prisma } from './prisma';
import { logger } from './logger';

/**
 * Helper centralizado para gerar notificações no sino (bell).
 * Cada função é fire-and-forget — não lança erro para não quebrar fluxos principais.
 *
 * Tipos de notificação por role:
 *
 *   ADMIN/STAFF:
 *     - PRODUCER_PENDING_KYC       novo produtor aguardando aprovação
 *     - AFFILIATE_PENDING          novo afiliado aguardando aprovação
 *     - WITHDRAWAL_REQUESTED       saque solicitado
 *     - PRODUCT_PENDING_REVIEW     produto pendente de revisão
 *
 *   PRODUCER:
 *     - NEW_SALE                   venda aprovada (já existente)
 *     - AFFILIATE_ENROLLED         afiliado se inscreveu no seu produto
 *     - PRODUCT_APPROVED           produto aprovado
 *     - PRODUCT_REJECTED           produto rejeitado
 *     - WITHDRAWAL_PAID            saque confirmado
 *
 *   AFFILIATE:
 *     - NEW_COMMISSION             comissão gerada (já existente, mesmo tipo NEW_SALE)
 *     - AFFILIATE_APPROVED         cadastro aprovado
 *     - AFFILIATE_REJECTED         cadastro rejeitado
 *     - MILESTONE_REACHED          marco atingido
 *     - WITHDRAWAL_PAID            saque confirmado
 */

type NotifInput = {
  userId  : string;
  type    : string;
  title   : string;
  body    : string;
  orderId?: string;
};

async function createMany(data: NotifInput[]): Promise<void> {
  if (data.length === 0) return;
  try {
    await prisma.notification.createMany({ data });
  } catch (err: any) {
    logger.warn({ err: err.message, count: data.length }, 'notify: falha ao criar (não crítico)');
  }
}

/** Envia notificação para todos os admins/staff ativos. */
async function notifyAdmins(input: Omit<NotifInput, 'userId'>): Promise<void> {
  const admins = await prisma.user.findMany({
    where : { role: { in: ['ADMIN', 'STAFF'] }, isActive: true },
    select: { id: true },
  });
  await createMany(admins.map(a => ({ ...input, userId: a.id })));
}

// ══════════════════════════════════════════════════════════════════
// EVENTOS
// ══════════════════════════════════════════════════════════════════

const fmt = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/** Novo produtor cadastrado — aguardando KYC */
export async function notifyProducerPendingKyc(producerName: string): Promise<void> {
  await notifyAdmins({
    type : 'PRODUCER_PENDING_KYC',
    title: '🆕 Novo produtor aguardando aprovação',
    body : `${producerName} enviou documentos e aguarda revisão do KYC.`,
  });
}

/** Novo afiliado cadastrado — aguardando aprovação */
export async function notifyAffiliatePending(affiliateName: string): Promise<void> {
  await notifyAdmins({
    type : 'AFFILIATE_PENDING',
    title: '🆕 Novo afiliado aguardando aprovação',
    body : `${affiliateName} se cadastrou e aguarda aprovação.`,
  });
}

/** Saque solicitado por um produtor/afiliado */
export async function notifyWithdrawalRequested(params: {
  requesterName: string;
  amountCents  : number;
}): Promise<void> {
  await notifyAdmins({
    type : 'WITHDRAWAL_REQUESTED',
    title: '💸 Novo saque solicitado',
    body : `${params.requesterName} solicitou ${fmt(params.amountCents)}.`,
  });
}

/** Produto pendente de revisão */
export async function notifyProductPendingReview(params: {
  producerName: string;
  productName : string;
}): Promise<void> {
  await notifyAdmins({
    type : 'PRODUCT_PENDING_REVIEW',
    title: '📦 Produto aguardando revisão',
    body : `${params.producerName} cadastrou "${params.productName}".`,
  });
}

/** Produto aprovado — avisa o produtor */
export async function notifyProductApproved(params: {
  producerUserId: string;
  productName   : string;
}): Promise<void> {
  await createMany([{
    userId: params.producerUserId,
    type  : 'PRODUCT_APPROVED',
    title : '✅ Produto aprovado',
    body  : `"${params.productName}" foi aprovado e já pode ser vendido.`,
  }]);
}

/** Produto rejeitado — avisa o produtor */
export async function notifyProductRejected(params: {
  producerUserId: string;
  productName   : string;
  reason?       : string;
}): Promise<void> {
  await createMany([{
    userId: params.producerUserId,
    type  : 'PRODUCT_REJECTED',
    title : '⚠️ Produto rejeitado',
    body  : params.reason
      ? `"${params.productName}": ${params.reason}`
      : `"${params.productName}" não foi aprovado. Revise os dados.`,
  }]);
}

/** Afiliado se inscreveu no produto — avisa o produtor */
export async function notifyAffiliateEnrolled(params: {
  producerUserId: string;
  affiliateName : string;
  productName   : string;
}): Promise<void> {
  await createMany([{
    userId: params.producerUserId,
    type  : 'AFFILIATE_ENROLLED',
    title : '🤝 Novo afiliado no seu produto',
    body  : `${params.affiliateName} se inscreveu em "${params.productName}".`,
  }]);
}

/** Afiliado aprovado — avisa o afiliado */
export async function notifyAffiliateApproved(params: { affiliateUserId: string }): Promise<void> {
  await createMany([{
    userId: params.affiliateUserId,
    type  : 'AFFILIATE_APPROVED',
    title : '🎉 Cadastro aprovado',
    body  : 'Seu cadastro de afiliado foi aprovado. Já pode começar a promover ofertas.',
  }]);
}

/** Afiliado rejeitado — avisa o afiliado */
export async function notifyAffiliateRejected(params: {
  affiliateUserId: string;
  reason?        : string;
}): Promise<void> {
  await createMany([{
    userId: params.affiliateUserId,
    type  : 'AFFILIATE_REJECTED',
    title : '⚠️ Cadastro recusado',
    body  : params.reason || 'Seu cadastro de afiliado foi recusado.',
  }]);
}

/** Marco/milestone alcançado — avisa o afiliado */
export async function notifyMilestoneReached(params: {
  affiliateUserId: string;
  milestoneName  : string;
  reward         : string;
}): Promise<void> {
  await createMany([{
    userId: params.affiliateUserId,
    type  : 'MILESTONE_REACHED',
    title : '🏆 Marco atingido!',
    body  : `"${params.milestoneName}" — ${params.reward}`,
  }]);
}

/** Saque pago — avisa o requisitante */
export async function notifyWithdrawalPaid(params: {
  userId     : string;
  amountCents: number;
}): Promise<void> {
  await createMany([{
    userId: params.userId,
    type  : 'WITHDRAWAL_PAID',
    title : '✅ Saque confirmado',
    body  : `${fmt(params.amountCents)} foi transferido para sua conta.`,
  }]);
}

/** Saque rejeitado — avisa o requisitante */
export async function notifyWithdrawalRejected(params: {
  userId     : string;
  amountCents: number;
  reason?    : string;
}): Promise<void> {
  await createMany([{
    userId: params.userId,
    type  : 'WITHDRAWAL_REJECTED',
    title : '⚠️ Saque recusado',
    body  : params.reason
      ? `${fmt(params.amountCents)} — ${params.reason}`
      : `${fmt(params.amountCents)} foi recusado.`,
  }]);
}
