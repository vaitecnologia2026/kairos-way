import { prisma } from '../utils/prisma';

/**
 * Sistema de taxas da plataforma.
 *
 * ARQUITETURA:
 * - Plataforma cobra 4 métodos simples: PIX, BOLETO, CARD, WITHDRAWAL
 * - Adquirente (Pagar.me) cobra granular: PIX, BOLETO, CARD_1X..CARD_12X, WITHDRAWAL
 * - Custos fixos adicionais do adquirente em toda transação de cartão:
 *   CARD_GATEWAY + CARD_ANTIFRAUDE
 *
 * FeePart é exclusivo: mode = 'PERCENT' (bps) OU 'FIXED' (cents).
 *
 * Lógica de resolução da taxa da plataforma:
 *   1. Se o usuário tem customFees[PLATFORM_METHOD] preenchido → usa ele
 *   2. Caso contrário → usa a taxa geral
 *
 * Adquirente não é customizável por usuário (é o custo real).
 *
 * Snapshot: cada Order salva em appliedFees a taxa fotografada no momento
 * da transação. Mudanças futuras não afetam vendas antigas.
 */

// ── Métodos que a PLATAFORMA cobra do produtor/afiliado ──
export const PLATFORM_METHODS = ['PIX', 'BOLETO', 'CARD', 'WITHDRAWAL'] as const;
export type PlatformMethod = typeof PLATFORM_METHODS[number];

// ── Métodos no lado do ADQUIRENTE ──
const CARD_INSTALLMENTS = Array.from({ length: 12 }, (_, i) => `CARD_${i + 1}X` as const);
export const ACQUIRER_METHODS = [
  'PIX', 'BOLETO',
  ...CARD_INSTALLMENTS,
  'CARD_GATEWAY',     // custo fixo somado a qualquer cartão (ex: R$0,55)
  'CARD_ANTIFRAUDE',  // custo fixo somado a qualquer cartão (ex: R$0,44)
  'WITHDRAWAL',
] as const;
export type AcquirerMethod = typeof ACQUIRER_METHODS[number];

export type CardInstallment = typeof CARD_INSTALLMENTS[number];

export interface FeePart {
  bps?  : number;  // % em basis points (1% = 100)
  cents?: number;  // R$ em centavos (R$ 1,00 = 100)
}

export const EMPTY_PART: FeePart = {};

export function isFilled(p?: FeePart | null): boolean {
  if (!p) return false;
  return (typeof p.bps === 'number' && p.bps > 0) || (typeof p.cents === 'number' && p.cents > 0);
}

export function normalizePart(p?: any): FeePart {
  if (!p || typeof p !== 'object') return {};
  const out: FeePart = {};
  if (typeof p.bps   === 'number' && p.bps   > 0) out.bps   = Math.floor(p.bps);
  if (typeof p.cents === 'number' && p.cents > 0) out.cents = Math.floor(p.cents);
  return out;
}

/** Soma % aplicada + R$ fixo → total em centavos sobre uma venda. */
export function partToCents(p: FeePart, saleCents: number): number {
  const pct = p.bps   ? Math.round(saleCents * p.bps / 10000) : 0;
  const fix = p.cents ?? 0;
  return pct + fix;
}

// ── Config da plataforma ──
export async function getPlatformFees(): Promise<Record<PlatformMethod, FeePart>> {
  const rows = await prisma.platformConfig.findMany({
    where: { key: { startsWith: 'fees.platform.' } },
  });
  const byKey = new Map(rows.map(r => [r.key, r.value as any]));
  const out: Record<PlatformMethod, FeePart> = {} as any;
  for (const m of PLATFORM_METHODS) {
    out[m] = normalizePart(byKey.get(`fees.platform.${m}`));
  }
  return out;
}

// ── Config do adquirente ──
export async function getAcquirerFees(): Promise<Record<AcquirerMethod, FeePart>> {
  const rows = await prisma.platformConfig.findMany({
    where: { key: { startsWith: 'fees.acquirer.' } },
  });
  const byKey = new Map(rows.map(r => [r.key, r.value as any]));
  const out: Record<AcquirerMethod, FeePart> = {} as any;
  for (const m of ACQUIRER_METHODS) {
    out[m] = normalizePart(byKey.get(`fees.acquirer.${m}`));
  }
  return out;
}

/** Mapeia PaymentMethod + installments para o método da plataforma. */
export function paymentToPlatformMethod(pm?: string | null): PlatformMethod {
  if (pm === 'PIX') return 'PIX';
  if (pm === 'BOLETO') return 'BOLETO';
  return 'CARD';
}

/** Mapeia PaymentMethod + installments para o método principal do adquirente. */
export function paymentToAcquirerMethod(pm?: string | null, installments = 1): AcquirerMethod {
  if (pm === 'PIX') return 'PIX';
  if (pm === 'BOLETO') return 'BOLETO';
  // Cartão — usa a parcela específica (1-12)
  const n = Math.min(12, Math.max(1, installments));
  return `CARD_${n}X` as AcquirerMethod;
}

/**
 * Resolve a taxa efetiva da plataforma para um usuário num método simples.
 * Custom fees substituem por método se preenchidas.
 */
export async function resolvePlatformFee(userId: string, method: PlatformMethod): Promise<{
  part    : FeePart;
  isCustom: boolean;
}> {
  const [producer, affiliate, platform] = await Promise.all([
    prisma.producer .findUnique({ where: { userId }, select: { customFees: true } }),
    prisma.affiliate.findUnique({ where: { userId }, select: { customFees: true } }),
    getPlatformFees(),
  ]);

  const customFees = (producer?.customFees ?? affiliate?.customFees ?? null) as Partial<Record<PlatformMethod, FeePart>> | null;
  const customPart = customFees?.[method];
  const hasCustom  = isFilled(customPart);

  return {
    part    : hasCustom ? normalizePart(customPart) : platform[method],
    isCustom: hasCustom,
  };
}

/**
 * Calcula o custo TOTAL do adquirente para uma transação.
 * Para cartão: MDR da parcela + Gateway + Antifraude.
 */
export async function computeAcquirerCost(params: {
  paymentMethod: string | null;
  installments : number;
  saleCents    : number;
}): Promise<{
  breakdown: Array<{ label: string; part: FeePart; cents: number }>;
  totalCents: number;
}> {
  const acq = await getAcquirerFees();
  const out: Array<{ label: string; part: FeePart; cents: number }> = [];
  const pm  = params.paymentMethod || '';

  if (pm === 'PIX') {
    const p = acq.PIX;
    out.push({ label: 'PIX', part: p, cents: partToCents(p, params.saleCents) });
  } else if (pm === 'BOLETO') {
    const p = acq.BOLETO;
    out.push({ label: 'Boleto', part: p, cents: partToCents(p, params.saleCents) });
  } else {
    // Cartão — MDR da parcela + Gateway + Antifraude
    const n = Math.min(12, Math.max(1, params.installments));
    const mdrKey = `CARD_${n}X` as AcquirerMethod;
    const mdr  = acq[mdrKey];
    const gw   = acq.CARD_GATEWAY;
    const af   = acq.CARD_ANTIFRAUDE;
    out.push({ label: `MDR ${n}x`,    part: mdr, cents: partToCents(mdr, params.saleCents) });
    if (isFilled(gw)) out.push({ label: 'Gateway',    part: gw, cents: partToCents(gw, params.saleCents) });
    if (isFilled(af)) out.push({ label: 'Antifraude', part: af, cents: partToCents(af, params.saleCents) });
  }

  const totalCents = out.reduce((s, x) => s + x.cents, 0);
  return { breakdown: out, totalCents };
}

/**
 * Fotografa a taxa aplicada a uma transação para persistir em Order.appliedFees.
 */
export async function snapshotFeeForTransaction(params: {
  userId       : string;
  paymentMethod: string | null;
  installments : number;
  saleCents    : number;
}): Promise<{
  platformMethod: PlatformMethod;
  platformPart  : FeePart;
  platformCents : number;
  acquirer      : { breakdown: Array<{ label: string; part: FeePart; cents: number }>; totalCents: number };
  marginCents   : number;
  isCustom      : boolean;
}> {
  const platformMethod = paymentToPlatformMethod(params.paymentMethod);
  const [platformRes, acquirer] = await Promise.all([
    resolvePlatformFee(params.userId, platformMethod),
    computeAcquirerCost({
      paymentMethod: params.paymentMethod,
      installments : params.installments,
      saleCents    : params.saleCents,
    }),
  ]);

  const platformCents = partToCents(platformRes.part, params.saleCents);
  return {
    platformMethod,
    platformPart  : platformRes.part,
    platformCents,
    acquirer,
    marginCents   : platformCents - acquirer.totalCents,
    isCustom      : platformRes.isCustom,
  };
}
