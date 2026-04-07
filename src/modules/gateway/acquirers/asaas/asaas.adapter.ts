import axios from 'axios';
import { IAcquirerAdapter, PaymentInput, PaymentResult } from '../../gateway.service';
import { SplitCalculation } from '../../../split-engine/split-engine.service';
import { PaymentError } from '../../../../shared/errors/AppError';
import { AcquirerName } from '@prisma/client';

export class AsaasAdapter implements IAcquirerAdapter {
  name: AcquirerName = 'ASAAS';
  private apiUrl = process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3';
  private apiKey = process.env.ASAAS_API_KEY || '';

  private get headers() {
    return { access_token: this.apiKey, 'Content-Type': 'application/json' };
  }

  async processPayment(input: PaymentInput, splits: SplitCalculation[]): Promise<PaymentResult> {
    const billingType = input.method === 'PIX' ? 'PIX'
      : input.method === 'CREDIT_CARD' ? 'CREDIT_CARD'
      : 'BOLETO';

    const payload: any = {
      customer: await this.getOrCreateCustomer(input.customerEmail, input.customerName, input.customerDoc),
      billingType,
      value: input.amountCents / 100,
      dueDate: new Date().toISOString().split('T')[0],
      description: 'Pagamento Kairos Way',
    };

    if (billingType === 'CREDIT_CARD' && input.cardToken) {
      payload.creditCardToken = input.cardToken;
      payload.installmentCount = input.installments || 1;
    }

    try {
      const r = await axios.post(`${this.apiUrl}/payments`, payload, { headers: this.headers });
      const payment = r.data;

      const result: PaymentResult = {
        acquirer: this.name,
        acquirerTxId: payment.id,
        status: payment.status === 'CONFIRMED' || payment.status === 'RECEIVED' ? 'APPROVED'
          : payment.status === 'PENDING' ? 'PENDING' : 'REJECTED',
        splits,
      };

      if (billingType === 'PIX') {
        result.pixCode = payment.pixTransaction?.payload;
        result.pixQrCode = payment.pixTransaction?.qrCode?.encodedImage
          ? `data:image/png;base64,${payment.pixTransaction.qrCode.encodedImage}`
          : undefined;
      } else if (billingType === 'BOLETO') {
        result.boletoUrl = payment.bankSlipUrl;
        result.boletoBarcode = payment.nossoNumero;
      }

      return result;
    } catch (err: any) {
      throw new PaymentError(`Asaas: ${err?.response?.data?.errors?.[0]?.description || err.message}`);
    }
  }

  async refund(acquirerTxId: string, amountCents: number): Promise<void> {
    await axios.post(
      `${this.apiUrl}/payments/${acquirerTxId}/refund`,
      { value: amountCents / 100 },
      { headers: this.headers }
    );
  }

  async getStatus(acquirerTxId: string): Promise<string> {
    const r = await axios.get(`${this.apiUrl}/payments/${acquirerTxId}`, { headers: this.headers });
    return r.data.status;
  }

  private async getOrCreateCustomer(email: string, name: string, doc?: string): Promise<string> {
    const search = await axios.get(`${this.apiUrl}/customers?email=${email}`, { headers: this.headers });
    if (search.data.data?.length > 0) return search.data.data[0].id;

    const create = await axios.post(
      `${this.apiUrl}/customers`,
      { name, email, cpfCnpj: doc?.replace(/\D/g, '') },
      { headers: this.headers }
    );
    return create.data.id;
  }
}
