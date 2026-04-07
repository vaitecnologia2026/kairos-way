import { IAcquirerAdapter, PaymentInput, PaymentResult } from '../../gateway.service';
import { SplitCalculation } from '../../../split-engine/split-engine.service';
import { PaymentError } from '../../../../shared/errors/AppError';
import { AcquirerName } from '@prisma/client';

export class CieloAdapter implements IAcquirerAdapter {
  name: AcquirerName = 'CIELO';

  async processPayment(_input: PaymentInput, _splits: SplitCalculation[]): Promise<PaymentResult> {
    // TODO: Implementar Cielo eCommerce API
    // Docs: https://developercielo.github.io/manual/cielo-ecommerce
    throw new PaymentError('Cielo: integração em implementação');
  }

  async refund(_acquirerTxId: string, _amountCents: number): Promise<void> {
    throw new PaymentError('Cielo: refund em implementação');
  }

  async getStatus(_acquirerTxId: string): Promise<string> {
    return 'UNKNOWN';
  }
}
