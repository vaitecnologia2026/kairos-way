import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

/**
 * NFe.io Service — Emissão de Nota Fiscal de Serviço (NFS-e)
 * Documentação: https://nfe.io/docs/developers/
 *
 * Variáveis de ambiente necessárias:
 * - NFEIO_API_KEY     → chave de API da NFe.io
 * - NFEIO_COMPANY_ID  → ID da empresa cadastrada na NFe.io
 */

export interface NFeAddress {
  street?      : string;  // line_1
  number?      : string;
  complement?  : string;  // line_2
  neighborhood?: string;
  city?        : string;
  state?       : string;  // UF (2 letras)
  zipCode?     : string;
  country?     : string;  // default BRA
}

export interface NFeInput {
  orderId        : string;
  customerName   : string;
  customerEmail  : string;
  customerDoc?   : string; // CPF ou CNPJ
  customerPhone? : string;
  customerAddress?: NFeAddress;  // obrigatório na NFe.io
  productName    : string;
  amountCents    : number;
  description?   : string;
}

export interface NFeResult {
  nfeId      : string;
  nfeNumber  : string;
  status     : 'issued' | 'processing' | 'failed';
  pdfUrl?    : string;
  xmlUrl?    : string;
  issuedAt   : string;
}

export interface NFeIoConfig {
  apiKey          : string;
  companyId       : string;
  cityServiceCode?: string;
}

export class NFeIoService {
  private readonly api      : AxiosInstance;
  private readonly companyId: string;
  private readonly cfg      : NFeIoConfig;

  /**
   * Aceita config por parâmetro (credenciais por usuário) ou fallback
   * para variáveis de ambiente.
   */
  constructor(config?: NFeIoConfig) {
    const apiKey    = config?.apiKey    ?? process.env.NFEIO_API_KEY;
    const companyId = config?.companyId ?? process.env.NFEIO_COMPANY_ID;

    if (!apiKey || !companyId) {
      logger.warn('NFe.io sem credenciais — emissão desabilitada');
    }

    this.companyId = companyId || '';
    this.cfg       = { apiKey: apiKey || '', companyId: companyId || '', cityServiceCode: config?.cityServiceCode };

    this.api = axios.create({
      baseURL: 'https://api.nfe.io/v1',
      headers: {
        'Authorization': apiKey || '',
        'Content-Type' : 'application/json',
        'Accept'       : 'application/json',
      },
      timeout: 30_000,
    });
  }

  /** Verifica credenciais buscando dados da empresa. */
  async testConnection(): Promise<{ ok: true; company: any } | { ok: false; error: string }> {
    if (!this.companyId || !this.cfg.apiKey) {
      return { ok: false, error: 'API key ou Company ID ausentes' };
    }
    try {
      const { data } = await this.api.get(`/companies/${this.companyId}`);
      return { ok: true, company: data };
    } catch (err: any) {
      logger.warn({ err: err?.response?.data || err.message }, 'NFe.io: testConnection falhou');
      return { ok: false, error: err?.response?.data?.message || 'Credenciais inválidas' };
    }
  }

  /**
   * Emitir Nota Fiscal de Serviço (NFS-e)
   * Para produtos digitais — código de serviço padrão LGPD
   */
  async emitir(input: NFeInput): Promise<NFeResult> {
    if (!this.companyId) {
      throw new Error('NFEIO_COMPANY_ID não configurado');
    }

    // Endereço do cliente (NFe.io exige para emitir)
    const addr = input.customerAddress || {};
    const address: Record<string, any> = { country: addr.country || 'BRA' };
    if (addr.street)       address.street        = addr.street;
    if (addr.number)       address.number        = addr.number;
    if (addr.complement)   address.additionalInformation = addr.complement;
    if (addr.neighborhood) address.district      = addr.neighborhood;
    if (addr.city)         address.city          = { name: addr.city };
    if (addr.state)        address.state         = addr.state.toUpperCase();
    if (addr.zipCode)      address.postalCode    = addr.zipCode.replace(/\D/g, '');

    // Construir payload conforme spec NFe.io v1
    const payload = {
      cityServiceCode : this.cfg.cityServiceCode || process.env.NFEIO_CITY_SERVICE_CODE || '01.07',
      description     : input.description || `${input.productName} — Pedido #${input.orderId.slice(-8).toUpperCase()}`,
      servicesAmount  : input.amountCents / 100,
      borrower        : {
        name             : input.customerName,
        email            : input.customerEmail,
        ...(input.customerDoc && this.buildDocument(input.customerDoc)),
        ...(input.customerPhone && { phoneNumber: input.customerPhone.replace(/\D/g, '') }),
        address,
      },
    };

    logger.info({ orderId: input.orderId, amount: payload.servicesAmount }, 'NFe.io: emitindo NFS-e');

    const response = await this.api.post(
      `/companies/${this.companyId}/serviceinvoices`,
      payload
    );

    const invoice = response.data;

    return {
      nfeId   : invoice.id,
      nfeNumber: invoice.number || invoice.invoiceNumber || '',
      status  : invoice.flowStatus === 'IssuedWithErrors' ? 'failed'
               : invoice.flowStatus === 'Issued'         ? 'issued'
               : 'processing',
      pdfUrl  : invoice.links?.find((l: any) => l.rel === 'pdf')?.href,
      xmlUrl  : invoice.links?.find((l: any) => l.rel === 'xml')?.href,
      issuedAt: invoice.issuedOn || new Date().toISOString(),
    };
  }

  /**
   * Consultar status de uma NF-e pelo ID
   */
  async consultar(nfeId: string): Promise<NFeResult> {
    const response = await this.api.get(
      `/companies/${this.companyId}/serviceinvoices/${nfeId}`
    );

    const invoice = response.data;

    return {
      nfeId   : invoice.id,
      nfeNumber: invoice.number || '',
      status  : invoice.flowStatus === 'Issued' ? 'issued' : 'processing',
      pdfUrl  : invoice.links?.find((l: any) => l.rel === 'pdf')?.href,
      xmlUrl  : invoice.links?.find((l: any) => l.rel === 'xml')?.href,
      issuedAt: invoice.issuedOn || '',
    };
  }

  /**
   * Cancelar uma NF-e
   */
  async cancelar(nfeId: string): Promise<void> {
    await this.api.delete(
      `/companies/${this.companyId}/serviceinvoices/${nfeId}`
    );
    logger.info({ nfeId }, 'NFe.io: NFS-e cancelada');
  }

  // ── HELPERS ───────────────────────────────────────────────────
  private buildDocument(doc: string) {
    const digits = doc.replace(/\D/g, '');

    // Validar CPF — rejeita sequências repetidas (00000000000, 11111111111, etc.)
    if (digits.length === 11) {
      const isRepeated = /^(\d){10}$/.test(digits);
      if (isRepeated) return {}; // CPF inválido — emite sem documento
      return { federalTaxNumber: Number(digits) };
    }

    // Validar CNPJ — rejeita sequências repetidas
    if (digits.length === 14) {
      const isRepeated = /^(\d){13}$/.test(digits);
      if (isRepeated) return {};
      return { federalTaxNumber: Number(digits) };
    }

    return {}; // documento ausente ou formato inválido — emite sem documento
  }
}
/** Helper para instanciar a partir da config salva em UserIntegration. */
export function buildNFeIo(config: any): NFeIoService | null {
  if (!config?.apiKey || !config?.companyId) return null;
  return new NFeIoService({
    apiKey          : config.apiKey,
    companyId       : config.companyId,
    cityServiceCode : config.cityServiceCode,
  });
}
