/** Validação matemática de CPF (Receita Federal). */
function validarCPF(cpf: string): boolean {
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  let r = (sum * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  if (r !== Number(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * (11 - i);
  r = (sum * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  return r === Number(d[10]);
}

/** Validação matemática de CNPJ. */
function validarCNPJ(cnpj: string): boolean {
  const d = cnpj.replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (s: string, n: number) => {
    let sum = 0;
    let pos = n - 7;
    for (let i = n; i >= 1; i--) {
      sum += Number(s[n - i]) * pos--;
      if (pos < 2) pos = 9;
    }
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  return calc(d, 12) === Number(d[12]) && calc(d, 13) === Number(d[13]);
}

/**
 * Valida CPF (11 dígitos) ou CNPJ (14 dígitos). Retorna mensagem de erro ou null se válido.
 * Aceita formatado (com pontos e traços) ou só dígitos.
 */
export function validateDocument(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length < 11) return 'CPF incompleto (precisa 11 dígitos)';
  if (digits.length === 11) return validarCPF(digits) ? null : 'CPF inválido';
  if (digits.length < 14) return 'CNPJ incompleto (precisa 14 dígitos)';
  return validarCNPJ(digits) ? null : 'CNPJ inválido';
}
