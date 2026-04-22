import { prisma } from '../utils/prisma';

/**
 * Prazos de liberação do valor após aprovação.
 *
 * HIERARQUIA: Pagar.me → Plataforma → Produtor/Afiliado
 *
 * Padrões (configuráveis via PlatformConfig):
 *   PIX:    1 dia
 *   BOLETO: 2 dias
 *   CARD:   15 dias
 *
 * Taxa de liberação pode ser personalizada por usuário em
 * Producer.customReleaseDays / Affiliate.customReleaseDays.
 * Campo ausente → herda padrão.
 */

export const RELEASE_METHODS = ['PIX', 'BOLETO', 'CARD'] as const;
export type ReleaseMethod = typeof RELEASE_METHODS[number];

export const DEFAULT_RELEASE_DAYS: Record<ReleaseMethod, number> = {
  PIX   : 1,
  BOLETO: 2,
  CARD  : 15,
};

/** Lê os prazos padrão da plataforma (fallback = DEFAULT). */
export async function getPlatformReleaseDays(): Promise<Record<ReleaseMethod, number>> {
  const rows = await prisma.platformConfig.findMany({
    where: { key: { startsWith: 'release.' } },
  });
  const byKey = new Map(rows.map(r => [r.key, r.value as any]));
  const out: Record<ReleaseMethod, number> = { ...DEFAULT_RELEASE_DAYS };
  for (const m of RELEASE_METHODS) {
    const v = byKey.get(`release.${m}`);
    if (v && typeof v.days === 'number' && v.days >= 0) out[m] = Math.floor(v.days);
  }
  return out;
}

/** Salva os prazos padrão da plataforma. */
export async function setPlatformReleaseDays(days: Partial<Record<ReleaseMethod, number>>): Promise<void> {
  const ops: any[] = [];
  for (const [method, d] of Object.entries(days)) {
    if (typeof d !== 'number' || d < 0) continue;
    const key = `release.${method}`;
    ops.push(prisma.platformConfig.upsert({
      where : { key },
      create: { key, value: { days: Math.floor(d) } },
      update: { value: { days: Math.floor(d) } },
    }));
  }
  await Promise.all(ops);
}

/**
 * Retorna o prazo efetivo de liberação para um usuário num método.
 * Custom substitui o padrão se preenchido.
 */
export async function resolveReleaseDays(userId: string, method: ReleaseMethod): Promise<{
  days    : number;
  isCustom: boolean;
}> {
  const [producer, affiliate, platform] = await Promise.all([
    prisma.producer .findUnique({ where: { userId }, select: { customReleaseDays: true } }),
    prisma.affiliate.findUnique({ where: { userId }, select: { customReleaseDays: true } }),
    getPlatformReleaseDays(),
  ]);

  const custom = (producer?.customReleaseDays ?? affiliate?.customReleaseDays ?? null) as Partial<Record<ReleaseMethod, number>> | null;
  const customDays = custom?.[method];
  const hasCustom  = typeof customDays === 'number' && customDays >= 0;

  return {
    days    : hasCustom ? Math.floor(customDays!) : platform[method],
    isCustom: hasCustom,
  };
}

/** Calcula a data em que o valor fica disponível para saque. */
export function calcAvailableAt(approvedAt: Date, days: number): Date {
  const d = new Date(approvedAt.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** Mapeia PaymentMethod (enum schema) para ReleaseMethod. */
export function paymentToReleaseMethod(pm?: string | null): ReleaseMethod {
  if (pm === 'PIX') return 'PIX';
  if (pm === 'BOLETO') return 'BOLETO';
  return 'CARD'; // CREDIT_CARD, DEBIT_CARD
}

/**
 * Resolve e calcula a data de liberação para uma transação de um usuário.
 */
export async function calcUserReleaseDate(params: {
  userId       : string;
  paymentMethod: string | null;
  approvedAt   : Date;
}): Promise<{
  availableAt: Date;
  days       : number;
  isCustom   : boolean;
}> {
  const method = paymentToReleaseMethod(params.paymentMethod);
  const { days, isCustom } = await resolveReleaseDays(params.userId, method);
  return {
    availableAt: calcAvailableAt(params.approvedAt, days),
    days,
    isCustom,
  };
}
