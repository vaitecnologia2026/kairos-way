import { prisma } from '../utils/prisma';

/**
 * Sistema de taxas da plataforma.
 *
 * Métodos de pagamento:
 *   PIX, BOLETO, CARD, WITHDRAWAL
 *
 * Cada FeePart pode conter bps (% em basis points) E/OU cents (R$ fixo).
 * Ambos opcionais — podem existir juntos (ex: 3,80% + R$ 3,00).
 *
 * Lógica de resolução:
 *   1. Se o usuário (produtor/afiliado) tiver customFees[method] preenchido → usa ele
 *   2. Caso contrário → usa taxa geral da plataforma
 *
 * A taxa aplicada é "fotografada" (snapshot) em Order.appliedFees no momento
 * da transação. Mudanças futuras não afetam transações antigas.
 */

export const FEE_METHODS = ['PIX', 'BOLETO', 'CARD', 'WITHDRAWAL'] as const;
export type FeeMethod = typeof FEE_METHODS[number];

export interface FeePart {
  bps?  : number;  // % em basis points (1% = 100)
  cents?: number;  // R$ em centavos (R$ 1,00 = 100)
}

export interface FeeConfig {
  platform: FeePart;
  acquirer: FeePart;
}

export const EMPTY_PART  : FeePart   = {};
export const EMPTY_CONFIG: FeeConfig = { platform: EMPTY_PART, acquirer: EMPTY_PART };

/** Normaliza um FeePart: remove zeros/undefined, retorna {} se vazio. */
export function normalizePart(p?: FeePart | null): FeePart {
  if (!p) return {};
  const out: FeePart = {};
  if (typeof p.bps   === 'number' && p.bps   > 0) out.bps   = Math.floor(p.bps);
  if (typeof p.cents === 'number' && p.cents > 0) out.cents = Math.floor(p.cents);
  return out;
}

/** Retorna true se o FeePart tem pelo menos um valor definido. */
export function isFilled(p?: FeePart | null): boolean {
  if (!p) return false;
  return (typeof p.bps === 'number' && p.bps > 0) || (typeof p.cents === 'number' && p.cents > 0);
}

/** Calcula quanto em centavos uma FeePart representa sobre uma venda. */
export function partToCents(p: FeePart, saleCents: number): number {
  const fromPct = p.bps   ? Math.round(saleCents * p.bps / 10000) : 0;
  const fromFix = p.cents ?? 0;
  return fromPct + fromFix;
}

/**
 * Retorna a taxa geral da plataforma para todos os métodos.
 * Lê PlatformConfig (keys: fees.PIX, fees.BOLETO, fees.CARD, fees.WITHDRAWAL).
 */
export async function getPlatformFees(): Promise<Record<FeeMethod, FeeConfig>> {
  const rows = await prisma.platformConfig.findMany({
    where: { key: { startsWith: 'fees.' } },
  });
  const byKey = new Map(rows.map(r => [r.key, r.value as any]));

  const out: Record<FeeMethod, FeeConfig> = {} as any;
  for (const m of FEE_METHODS) {
    const raw = byKey.get(`fees.${m}`);
    out[m] = {
      platform: normalizePart(raw?.platform),
      acquirer: normalizePart(raw?.acquirer),
    };
  }
  return out;
}

/**
 * Resolve a taxa efetiva de um usuário para um método específico.
 * Se o usuário tiver customFees[method] preenchido, usa ele (substitui a geral).
 * Caso contrário, usa a taxa geral.
 *
 * A taxa do adquirente vem sempre da config geral — não é customizável por usuário.
 */
export async function resolveEffectiveFee(userId: string, method: FeeMethod): Promise<{
  platform: FeePart;
  acquirer: FeePart;
  isCustom: boolean;
}> {
  const [producer, affiliate, platformFees] = await Promise.all([
    prisma.producer .findUnique({ where: { userId }, select: { customFees: true } }),
    prisma.affiliate.findUnique({ where: { userId }, select: { customFees: true } }),
    getPlatformFees(),
  ]);

  const customFees = (producer?.customFees ?? affiliate?.customFees ?? null) as Partial<Record<FeeMethod, FeePart>> | null;
  const customPart = customFees?.[method];
  const hasCustom  = isFilled(customPart);

  const base       = platformFees[method];
  const platform   = hasCustom ? normalizePart(customPart) : base.platform;
  const acquirer   = base.acquirer;

  return { platform, acquirer, isCustom: hasCustom };
}

/**
 * "Fotografa" a taxa aplicada a uma transação para persistir em Order.appliedFees.
 */
export async function snapshotFeeForTransaction(params: {
  userId    : string;
  method    : FeeMethod;
  saleCents : number;
}): Promise<{
  method       : FeeMethod;
  platform     : FeePart;
  acquirer     : FeePart;
  platformCents: number; // quanto a plataforma cobrou do produtor
  acquirerCents: number; // quanto a plataforma paga ao adquirente
  marginCents  : number; // lucro da plataforma (platform − acquirer)
  isCustom     : boolean;
}> {
  const { platform, acquirer, isCustom } = await resolveEffectiveFee(params.userId, params.method);
  const platformCents = partToCents(platform, params.saleCents);
  const acquirerCents = partToCents(acquirer, params.saleCents);
  return {
    method       : params.method,
    platform,
    acquirer,
    platformCents,
    acquirerCents,
    marginCents  : platformCents - acquirerCents,
    isCustom,
  };
}

/** Mapeia PaymentMethod (enum do schema) para FeeMethod. */
export function paymentToFeeMethod(pm?: string | null): FeeMethod {
  if (pm === 'PIX') return 'PIX';
  if (pm === 'BOLETO') return 'BOLETO';
  return 'CARD'; // CREDIT_CARD, DEBIT_CARD, default
}
