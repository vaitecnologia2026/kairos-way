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

export interface NFeInput {
  orderId        : string;
  customerName   : string;
  customerEmail  : string;
  customerDoc?   : string; // CPF ou CNPJ
  customerPhone? : string;
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

export class NFeIoService {
  private readonly api    : AxiosInstance;
  private readonly companyId: string;

  constructor() {
    const apiKey    = process.env.NFEIO_API_KEY;
    const companyId = process.env.NFEIO_COMPANY_ID;

    if (!apiKey || !companyId) {
      logger.warn('NFEIO_API_KEY ou NFEIO_COMPANY_ID não configurados — emissão de NF-e desabilitada');
    }

    this.companyId = companyId || '';

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

  /**
   * Emitir Nota Fiscal de Serviço (NFS-e)
   * Para produtos digitais — código de serviço padrão LGPD
   */
  async emitir(input: NFeInput): Promise<NFeResult> {
    if (!this.companyId) {
      throw new Error('NFEIO_COMPANY_ID não configurado');
    }

    // Construir payload conforme spec NFe.io v1
    const payload = {
      cityServiceCode : process.env.NFEIO_CITY_SERVICE_CODE || '01.07',    // código de serviço municipal
      description     : input.description || `${input.productName} — Pedido #${input.orderId.slice(-8).toUpperCase()}`,
      servicesAmount  : input.amountCents / 100,
      borrower        : {
        name             : input.customerName,
        email            : input.customerEmail,
        ...(input.customerDoc && this.buildDocument(input.customerDoc)),
        ...(input.customerPhone && { phoneNumber: input.customerPhone.replace(/\D/g, '') }),
        address          : {
          country: 'BRA',
        },
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