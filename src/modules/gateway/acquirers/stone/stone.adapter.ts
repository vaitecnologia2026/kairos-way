import { IAcquirerAdapter, PaymentInput, PaymentResult } from '../../gateway.service';
import { SplitCalculation } from '../../../split-engine/split-engine.service';
import { PaymentError } from '../../../../shared/errors/AppError';
import { AcquirerName } from '@prisma/client';

// Stone adapter — OAuth2 flow
export class StoneAdapter implements IAcquirerAdapter {
  name: AcquirerName = 'STONE';
  private apiUrl = process.env.STONE_API_URL || 'https://sandbox.openbank.stone.com.br';

  async processPayment(_input: PaymentInput, _splits: SplitCalculation[]): Promise<PaymentResult> {
    // TODO: Implementar OAuth2 Stone + payment creation
    // Docs: https://docs.openbank.stone.com.br/
    throw new PaymentError('Stone: integração em implementação');
  }

  async refund(_acquirerTxId: string, _amountCents: number): Promise<void> {
    throw new PaymentError('Stone: refund em implementação');
  }

  async getStatus(_acquirerTxId: string): Promise<string> {
    return 'UNKNOWN';
  }
}
