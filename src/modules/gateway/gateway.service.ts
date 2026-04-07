import { SplitEngineService, SplitCalculation } from '../split-engine/split-engine.service';
import { AuditService } from '../audit/audit.service';
import { PaymentError } from '../../shared/errors/AppError';
import { AcquirerName, PaymentMethod } from '@prisma/client';
import { PagarmeAdapter } from './acquirers/pagarme/pagarme.adapter';
import { AsaasAdapter } from './acquirers/asaas/asaas.adapter';
import { StoneAdapter } from './acquirers/stone/stone.adapter';
import { CieloAdapter } from './acquirers/cielo/cielo.adapter';

export interface PaymentInput {
  offerId: string;
  amountCents: number;
  method: PaymentMethod;
  installments?: number;
  customerEmail: string;
  customerName: string;
  customerDoc?: string;
  cardToken?: string;
  billingAddress?: Record<string, string>;
  ip?: string;
}

export interface PaymentResult {
  acquirer: AcquirerName;
  acquirerTxId: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  pixCode?: string;
  pixQrCode?: string;
  boletoUrl?: string;
  boletoBarcode?: string;
  splits: SplitCalculation[];
}

export interface IAcquirerAdapter {
  name: AcquirerName;
  processPayment(input: PaymentInput, splits: SplitCalculation[]): Promise<PaymentResult>;
  refund(acquirerTxId: string, amountCents: number): Promise<void>;
  getStatus(acquirerTxId: string): Promise<string>;
}

const splitEngine = new SplitEngineService();
const auditService = new AuditService();

/**
 * GATEWAY SERVICE — Multi-adquirente com failover automático
 * 
 * Ordem de tentativa:
 * 1. Pagar.me (principal)
 * 2. Asaas
 * 3. Stone
 * 4. Cielo (backup)
 */
export class GatewayService {
  private adapters: IAcquirerAdapter[] = [
    new PagarmeAdapter(),
    new AsaasAdapter(),
    new StoneAdapter(),
    new CieloAdapter(),
  ];

  /** Processar pagamento com failover automático */
  async processPayment(input: PaymentInput): Promise<PaymentResult> {
    const splits = await splitEngine.calculate(input.offerId, input.amountCents);
    const errors: Array<{ acquirer: string; error: string }> = [];

    for (const adapter of this.adapters) {
      try {
        await auditService.log({
          action: 'PAYMENT_ATTEMPT',
          details: { acquirer: adapter.name, offerId: input.offerId, amountCents: input.amountCents },
          level: 'LOW',
        });

        const result = await adapter.processPayment(input, splits);
        result.splits = splits;

        await auditService.log({
          action: 'PAYMENT_SUCCESS',
          details: {
            acquirer: adapter.name,
            acquirerTxId: result.acquirerTxId,
            status: result.status,
          },
          level: 'MEDIUM',
        });

        return result;
      } catch (err: any) {
        const errMsg = err?.message || 'Erro desconhecido';
        errors.push({ acquirer: adapter.name, error: errMsg });

        await auditService.log({
          action: 'ACQUIRER_FAIL',
          details: { acquirer: adapter.name, error: errMsg },
          level: 'HIGH',
        });

        // Se é falha de dados do cliente (não de adquirente), não tentar próximo
        if (err?.clientError) throw err;

        continue; // Tentar próximo adquirente
      }
    }

    // Todos os adquirentes falharam
    await auditService.log({
      action: 'ALL_ACQUIRERS_FAILED',
      details: { errors },
      level: 'CRITICAL',
    });

    throw new PaymentError(
      `Todos os adquirentes falharam. Tente novamente em instantes. Erros: ${errors.map((e) => e.acquirer).join(', ')}`
    );
  }

  /** Reembolso — tenta no adquirente original */
  async refund(acquirerName: AcquirerName, acquirerTxId: string, amountCents: number): Promise<void> {
    const adapter = this.adapters.find((a) => a.name === acquirerName);
    if (!adapter) throw new PaymentError(`Adquirente ${acquirerName} não encontrado`);

    await adapter.refund(acquirerTxId, amountCents);
    await auditService.log({
      action: 'REFUND_PROCESSED',
      details: { acquirer: acquirerName, acquirerTxId, amountCents },
      level: 'HIGH',
    });
  }

  /** Status de uma transação */
  async getStatus(acquirerName: AcquirerName, acquirerTxId: string): Promise<string> {
    const adapter = this.adapters.find((a) => a.name === acquirerName);
    if (!adapter) throw new PaymentError(`Adquirente ${acquirerName} não encontrado`);
    return adapter.getStatus(acquirerTxId);
  }
}
