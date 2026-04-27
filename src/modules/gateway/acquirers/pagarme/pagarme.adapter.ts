import axios, { AxiosInstance } from 'axios';
import { logger } from '../../../../shared/utils/logger';
import { PaymentError } from '../../../../shared/errors/AppError';
import type { IAcquirerAdapter } from '../../gateway.service';
import type { PaymentInput, PaymentResult } from '../../gateway.service';
import type { SplitCalculation } from '../../../split-engine/split-engine.service';
import { AcquirerName } from '@prisma/client';

/**
 * Pagar.me Adapter — API V5
 * Documentação: https://docs.pagar.me/reference
 *
 * Suporta: PIX, CREDIT_CARD, BOLETO
 * Ambiente: sandbox (sk_test_) ou production (sk_live_)
 */
export class PagarmeAdapter implements IAcquirerAdapter {
  name: AcquirerName = 'PAGARME';

  private readonly api: AxiosInstance;
  private readonly accountId: string;

  constructor() {
    const apiKey    = process.env.PAGARME_API_KEY;
    const accountId = process.env.PAGARME_ACCOUNT_ID;

    if (!apiKey || !accountId) {
      throw new Error('PAGARME_API_KEY e PAGARME_ACCOUNT_ID são obrigatórios');
    }

    this.accountId = accountId;

    this.api = axios.create({
      baseURL: 'https://api.pagar.me/core/v5',
      headers: {
        // Pagar.me V5 usa Basic Auth com a secret key como username
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
  }

  // ── PROCESSAR PAGAMENTO ───────────────────────────────────────
  async processPayment(
    input : PaymentInput,
    splits: SplitCalculation[]
  ): Promise<PaymentResult> {
    const customer = this.buildCustomer(input);

    switch (input.method) {
      case 'PIX':         return this.processPix(input, customer);
      case 'CREDIT_CARD': return this.processCard(input, customer, splits);
      case 'BOLETO':      return this.processBoleto(input, customer);
      default:
        throw new PaymentError(`Método de pagamento não suportado: ${input.method}`);
    }
  }

  // ── PIX ────────────────────────────────────────────────────────
  private async processPix(
    input   : PaymentInput,
    customer: Record<string, any>
  ): Promise<PaymentResult> {
    const orderCode = input.orderId || input.offerId.slice(-8).toUpperCase();
    const itemCode  = input.offerId.slice(-8).toUpperCase();
    const desc = input.productName || `Pedido ${orderCode}`;
    const payload = {
      code: orderCode,
      items: [{
        amount     : input.amountCents,
        description: desc,
        quantity   : 1,
        code       : itemCode,
      }],
      customer,
      payments: [{
        payment_method: 'pix',
        pix           : {
          expires_in: 900, // 15 minutos — PCI RN-014
        },
      }],
      metadata: {
        offerId    : input.offerId,
        ip         : input.ip,
        description: desc,
      },
    };

    try {
      const { data } = await this.api.post('/orders', payload);

      const charge = data.charges?.[0];
      const lastTransaction = charge?.last_transaction;

      if (!charge || !lastTransaction) {
        throw new PaymentError('Resposta inválida do Pagar.me para PIX');
      }

      // Log detalhado para diagnosticar PIX indo para REJECTED indevidamente
      logger.info({
        chargeStatus  : charge.status,
        txStatus      : lastTransaction.status,
        hasQrCode     : !!lastTransaction.qr_code,
        gatewayReason : lastTransaction.gateway_response?.errors?.[0]?.message,
      }, 'PIX_DEBUG');

      let status = this.mapStatus(charge.status);

      // Regra: se o Pagar.me gerou um QR válido (qr_code presente), o pagamento
      // pode ser concluído pelo cliente — tratamos como PENDING mesmo que o
      // charge.status inicial reporte algo inesperado (ex: pending-before-qr).
      if (lastTransaction.qr_code && status === 'REJECTED') {
        logger.warn({
          orderCode   : orderCode,
          chargeStatus: charge.status,
        }, 'PIX: charge marcado como REJECTED mas QR foi gerado — forçando PENDING');
        status = 'PENDING';
      }

      return {
        acquirer     : 'PAGARME',
        acquirerTxId : charge.id,
        status,
        pixCode      : lastTransaction.qr_code,
        pixQrCode    : lastTransaction.qr_code_url,
      };
    } catch (err: any) {
      this.handleError(err, 'PIX');
    }
  }

  // ── CARTÃO DE CRÉDITO ─────────────────────────────────────────
  private async processCard(
    input   : PaymentInput,
    customer: Record<string, any>,
    splits  : SplitCalculation[]
  ): Promise<PaymentResult> {
    if (!input.cardToken) {
      const err: any = new Error('cardToken obrigatório para pagamento com cartão');
      err.clientError = true;
      throw err;
    }

    const installments = input.installments || 1;

    // billing é OBRIGATÓRIO no payload Pagar.me (name + address.line_1/zip/city/state/country).
    // Frontend envia { street, number, complement, neighborhood, city, state, zipCode, country }.
    // Doc: https://docs.pagar.me/reference/cartão-de-crédito-1
    const raw  = (input.billingAddress as Record<string, any>) || {};
    const line1 = [raw.number, raw.street, raw.neighborhood].filter(Boolean).join(', ')
      || raw.line_1
      || '000, Rua';
    const billingName =
      (input as any).cardHolder ||
      raw.name ||
      input.customerName ||
      customer.name ||
      'CLIENTE';

    const payload = {
      amount  : input.amountCents,
      customer,
      payment : {
        payment_method: 'credit_card',
        credit_card   : {
          installments,
          statement_descriptor: 'KAIROSWAY',
          card                : { token: input.cardToken },
          billing             : {
            name   : String(billingName).slice(0, 64),
            address: {
              line_1  : line1,
              zip_code: (raw.zipCode || raw.zip_code || '01310100').toString().replace(/\D/g, ''),
              city    : raw.city  || 'Sao Paulo',
              state   : (raw.state || 'SP').toUpperCase(),
              country : raw.country || 'BR',
              ...(raw.complement || raw.line_2 ? { line_2: raw.complement || raw.line_2 } : {}),
            },
          },
        },
      },
    };

    try {
      const { data } = await this.api.post('/charges', payload);

      // /charges retorna o objeto direto (sem charges[])
      const charge          = data;
      const lastTransaction = data.last_transaction;

      if (!charge || !lastTransaction) {
        throw new PaymentError('Resposta inválida do Pagar.me para cartão');
      }

      // Log para debug — remover após confirmar funcionamento
      logger.info({
        chargeStatus : charge.status,
        txStatus     : lastTransaction.status,
        returnCode   : lastTransaction.acquirer_return_code,
        acquirerMsg  : lastTransaction.acquirer_message,
      }, 'CARD_DEBUG');

      // Rejeita apenas quando status for explicitamente failed
      if (lastTransaction.status === 'failed') {
        const err: any = new PaymentError(
          lastTransaction.acquirer_message ||
          lastTransaction.gateway_response?.errors?.[0]?.message ||
          'Cartão recusado pela operadora'
        );
        err.clientError = true;
        throw err;
      }

      return {
        acquirer    : 'PAGARME',
        acquirerTxId: charge.id,
        status      : this.mapStatus(charge.status),
      };
    } catch (err: any) {
      this.handleError(err, 'CREDIT_CARD');
    }
  }

  // ── BOLETO ────────────────────────────────────────────────────
  private async processBoleto(
    input   : PaymentInput,
    customer: Record<string, any>
  ): Promise<PaymentResult> {
    // Boleto vence em 3 dias úteis
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 3);

    const orderCode = input.orderId || input.offerId.slice(-8).toUpperCase();
    const itemCode  = input.offerId.slice(-8).toUpperCase();
    const desc = input.productName || `Pedido ${orderCode}`;

    const payload = {
      code: orderCode,
      items: [{
        amount     : input.amountCents,
        description: desc,
        quantity   : 1,
        code       : itemCode,
      }],
      customer,
      payments: [{
        payment_method: 'boleto',
        boleto        : {
          due_at     : dueDate.toISOString(),
          instructions: 'Não aceitar após o vencimento.',
        },
        amount: input.amountCents,
      }],
      metadata: { offerId: input.offerId, ip: input.ip },
    };

    try {
      const { data } = await this.api.post('/orders', payload);

      const charge          = data.charges?.[0];
      const lastTransaction = charge?.last_transaction;

      if (!charge || !lastTransaction) {
        throw new PaymentError('Resposta inválida do Pagar.me para boleto');
      }

      // Pagar.me V5 pode retornar PDF em campos diferentes conforme a conta:
      //   lastTransaction.pdf                 (mais comum)
      //   lastTransaction.url                 (boleto digital)
      //   lastTransaction.billet_url
      //   lastTransaction.boleto_url
      const boletoUrl = lastTransaction.pdf
        || lastTransaction.url
        || lastTransaction.billet_url
        || lastTransaction.boleto_url
        || null;
      const boletoBarcode = lastTransaction.line
        || lastTransaction.barcode
        || lastTransaction.boleto_barcode
        || null;

      logger.info({
        chargeId     : charge.id,
        hasPdf       : !!boletoUrl,
        hasBarcode   : !!boletoBarcode,
        txKeys       : Object.keys(lastTransaction),
      }, 'BOLETO_DEBUG: campos retornados pelo Pagar.me');

      return {
        acquirer     : 'PAGARME',
        acquirerTxId : charge.id,
        status       : 'PENDING', // boleto sempre PENDING até pagamento
        boletoUrl    : boletoUrl || undefined,
        boletoBarcode: boletoBarcode || undefined,
      };
    } catch (err: any) {
      this.handleError(err, 'BOLETO');
    }
  }

  // ── REEMBOLSO ─────────────────────────────────────────────────
  async refund(acquirerTxId: string, amountCents: number): Promise<void> {
    try {
      // No Pagar.me V5, reembolso é feito via charge
      await this.api.post(`/charges/${acquirerTxId}/cancel`, {
        amount: amountCents,
        reason: 'Solicitação de reembolso',
      });
      logger.info({ acquirerTxId, amountCents }, 'Pagar.me: reembolso processado');
    } catch (err: any) {
      this.handleError(err, 'REFUND');
    }
  }

  // ── STATUS ────────────────────────────────────────────────────
  async getStatus(acquirerTxId: string): Promise<string> {
    try {
      const { data } = await this.api.get(`/charges/${acquirerTxId}`);
      return data.status || 'unknown';
    } catch (err: any) {
      this.handleError(err, 'GET_STATUS');
    }
  }

  // ── CRIAR CARTÃO TOKENIZADO (para uso no frontend) ─────────────
  async createCardToken(params: {
    number    : string;
    holderName: string;
    expMonth  : string;
    expYear   : string;
    cvv       : string;
  }): Promise<string> {
    try {
      const publicKey = process.env.PAGARME_PUBLIC_KEY;
      if (!publicKey) throw new Error('PAGARME_PUBLIC_KEY não configurado');

      const { data } = await axios.post(
        'https://api.pagar.me/core/v5/tokens',
        {
          type: 'card',
          card: {
            number     : params.number.replace(/\s/g, ''),
            holder_name: params.holderName,
            exp_month  : params.expMonth,
            exp_year   : params.expYear,
            cvv        : params.cvv,
          },
        },
        {
          params : { appId: publicKey },
          headers: { 'Content-Type': 'application/json' },
        }
      );
      return data.id; // card_token_xxx
    } catch (err: any) {
      this.handleError(err, 'CARD_TOKEN');
    }
  }

  // ── HELPERS ───────────────────────────────────────────────────

  private buildCustomer(input: PaymentInput): Record<string, any> {
    const customer: Record<string, any> = {
      name : input.customerName,
      email: input.customerEmail,
      type : 'individual',
    };

    if (input.customerDoc) {
      const digits = input.customerDoc.replace(/\D/g, '');
      customer.document      = digits;
      customer.document_type = digits.length === 11 ? 'CPF' : 'CNPJ';
    }

    if (input.customerPhone) {
      const digits = input.customerPhone.replace(/\D/g, '');
      customer.phones = {
        mobile_phone: {
          country_code: '55',
          area_code   : digits.slice(0, 2),
          number      : digits.slice(2),
        },
      };
    }

    // Endereço do cliente — obrigatório para emissão de NFe (consumido pelo
    // Pluga depois e enviado ao NFe.io). billingAddress vem do checkout.
    const addr = input.billingAddress as Record<string, any> | undefined;
    if (addr && (addr.zipCode || addr.street)) {
      customer.address = {
        country    : addr.country || 'BR',
        state      : (addr.state  || '').toUpperCase(),
        city       : addr.city   || '',
        zip_code   : (addr.zipCode || '').replace(/\D/g, ''),
        line_1     : [addr.number, addr.street, addr.neighborhood]
                       .filter(Boolean).join(', '),
        line_2     : addr.complement || '',
      };
    }

    return customer;
  }

  private buildSplits(splits: SplitCalculation[]): any[] {
    // Splits nativos do Pagar.me — apenas para recebedores cadastrados na plataforma
    // Recipients precisam ser criados previamente via API do Pagar.me
    // Por ora, retorna array vazio (repasses feitos via SplitEngine interno)
    return [];
  }

  private mapStatus(pagarmeStatus: string): 'APPROVED' | 'PENDING' | 'REJECTED' {
    switch (pagarmeStatus) {
      case 'paid':
      case 'authorized':
        return 'APPROVED';

      case 'pending':
      case 'processing':
      case 'waiting_payment':
        return 'PENDING';

      case 'failed':
      case 'canceled':
      case 'chargedback':
        return 'REJECTED';

      default:
        logger.warn({ pagarmeStatus }, 'Pagar.me: status desconhecido');
        return 'PENDING';
    }
  }

  private handleError(err: any, context: string): never {
    // Repassar erros de cliente sem wrapping
    if (err.clientError) throw err;

    const pagarmeMsg = err?.response?.data?.message ||
                       err?.response?.data?.errors?.[0]?.message;
    const statusCode = err?.response?.status;

    logger.error({
      context,
      statusCode,
      pagarmeMsg,
      fullError: JSON.stringify(err?.response?.data),
      err: err.message,
    }, 'Pagar.me: erro na chamada');

    if (statusCode === 422 || statusCode === 400) {
      const error: any = new PaymentError(pagarmeMsg || 'Dados de pagamento inválidos');
      error.clientError = true;
      throw error;
    }

    throw new PaymentError(
      pagarmeMsg || `Pagar.me indisponível (${context}). Tentando próximo adquirente...`
    );
  }
}