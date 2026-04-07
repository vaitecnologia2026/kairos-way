import axios from 'axios';
import { logger } from '../utils/logger';

/**
 * WhatsApp Service — API Vai Tecnologia
 *
 * Variáveis de ambiente:
 * - VAI_API_URL      → https://backend-chat.vaidavenda.com.br
 * - VAI_API_TOKEN    → Bearer token da API
 * - VAI_WHATSAPP_ID  → ID da conexão WhatsApp (4b938621-3f9d-4409-bb00-b27bdc171ba4)
 */

const METHOD_LABEL: Record<string, string> = {
  PIX        : 'Pix',
  CREDIT_CARD: 'Cartão de crédito',
  BOLETO     : 'Boleto',
};

export interface WhatsAppMessageParams {
  phone        : string;  // número do cliente com DDI — ex: 5548999999999
  customerName : string;
  productName  : string;
  paymentMethod: string;
  digitalUrl   : string;
}

export class WhatsAppService {
  private readonly baseUrl    : string;
  private readonly token      : string;
  private readonly whatsappId : string;

  constructor() {
    this.baseUrl    = (process.env.VAI_API_URL    || 'https://backend-chat.vaidavenda.com.br').replace(/\/$/, '');
    this.token      = process.env.VAI_API_TOKEN   || '';
    this.whatsappId = process.env.VAI_WHATSAPP_ID || '4b938621-3f9d-4409-bb00-b27bdc171ba4';
  }

  /**
   * Envia mensagem de confirmação de compra com link do produto
   */
  async sendWithdrawalConfirmation(params: {
    phone       : string;
    customerName: string;
    amountCents : number;
    pixKey      : string;
  }): Promise<void> {
    const phone   = this.formatPhone(params.phone);
    const value   = `R$ ${(params.amountCents / 100).toFixed(2).replace('.', ',')}`;
    const message = `Olá ${params.customerName}! 💰 Seu saque de *${value}* foi processado com sucesso.

Chave Pix: ${params.pixKey}

O valor já está a caminho da sua conta. Obrigado por usar a Kairos Way!`;

    try {
      await axios.post(
        `${this.baseUrl}/api/v1/messages`,
        {
          whatsappId: this.whatsappId,
          messages: [{ number: phone, name: params.customerName, body: message }],
        },
        { headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, timeout: 15_000 }
      );
      logger.info({ phone, amount: params.amountCents }, 'WhatsApp: confirmação de saque enviada');
    } catch (err: any) {
      logger.warn({ phone, err: err.message }, 'WhatsApp: falha na confirmação de saque — fluxo não interrompido');
      // Não propaga o erro
    }
  }

  async sendPurchaseConfirmation(params: WhatsAppMessageParams): Promise<void> {
    if (!this.token) {
      logger.warn('VAI_API_TOKEN não configurado — WhatsApp não enviado');
      return;
    }

    const phone   = this.formatPhone(params.phone);
    const method  = METHOD_LABEL[params.paymentMethod] || params.paymentMethod;
    const message = `Olá ${params.customerName}! Sua compra via ${method} do *${params.productName}* foi confirmada. 🎉\n\nAcesse seu produto aqui:\n${params.digitalUrl}`;

    try {
      await axios.post(
        `${this.baseUrl}/api/v1/messages`,
        {
          whatsappId: this.whatsappId,
          messages: [
            {
              number: phone,
              name  : params.customerName,
              body  : message,
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        }
      );

      logger.info({ phone, productName: params.productName }, 'WhatsApp: confirmação enviada');
    } catch (err: any) {
      const status = err?.response?.status;
      const data   = err?.response?.data;
      logger.warn({ phone, status: err?.response?.status, err: err.message }, 'WhatsApp: falha no envio — fluxo não interrompido');
      // Não propaga o erro — WhatsApp é notificação opcional
    }
  }

  /**
   * Formata o telefone para o padrão da API Vai
   * Entrada: (48) 99999-9999 ou 48999999999
   * Saída: 5548999999999
   */
  private formatPhone(phone: string): string {
    let digits = phone.replace(/\D/g, '');

    // Remove DDI 55 se já tiver para processar o número limpo
    if (digits.startsWith('55')) digits = digits.slice(2);

    // Extrai DDD e número
    const ddd    = parseInt(digits.slice(0, 2), 10);
    let number   = digits.slice(2);

    // DDD > 31 → remove o 9º dígito (celular de 8 dígitos)
    // DDD <= 31 → mantém o 9º dígito (SP, RJ, MG — celular de 9 dígitos)
    if (ddd > 31 && number.length === 9 && number.startsWith('9')) {
      number = number.slice(1);
    }

    return `55${ddd}${number}`;
  }
}

export const whatsAppService = new WhatsAppService();