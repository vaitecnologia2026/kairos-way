/**
 * REGRA CRÍTICA: Todos os valores monetários são em CENTAVOS (inteiros)
 * Split Engine usa BASIS POINTS: 1% = 100 bps; 100% = 10000 bps
 */

/** Converte reais para centavos */
export function toCents(reais: number): number {
  return Math.round(reais * 100);
}

/** Converte centavos para reais */
export function toReais(cents: number): number {
  return cents / 100;
}

/** Formata centavos para exibição: R$ 1.234,56 */
export function formatBRL(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

/**
 * Calcula valor em centavos a partir de basis points
 * @param amountCents - valor total em centavos
 * @param basisPoints - porcentagem em bps (1% = 100 bps)
 */
export function calcBps(amountCents: number, basisPoints: number): number {
  return Math.floor((amountCents * basisPoints) / 10000);
}

/** Converte porcentagem para basis points: 20.5% → 2050 */
export function pctToBps(pct: number): number {
  return Math.round(pct * 100);
}

/** Converte basis points para porcentagem: 2050 → 20.5 */
export function bpsToPct(bps: number): number {
  return bps / 100;
}

/** Valida que a soma dos splits é exatamente 10000 bps (100%) */
export function validateSplitSum(bpsArray: number[]): boolean {
  return bpsArray.reduce((a, b) => a + b, 0) === 10000;
}
