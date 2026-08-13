import crypto from 'node:crypto';
import type { PaymentProvider, PaymentRequest, PaymentResult } from './provider.js';

/**
 * Simulated gateway. No network calls, no real money, deterministic outcomes so
 * tests and demos can exercise both the happy path and the decline path.
 *
 * Card number behaviour:
 *   4242 4242 4242 4242  -> approved
 *   4000 0000 0000 0002  -> declined (card_declined)
 *   4000 0000 0000 0069  -> declined (expired_card)
 *   4000 0000 0000 0119  -> declined (processing_error)
 *   anything else        -> approved when the last digit is even, declined when odd
 */
const SCRIPTED: Record<string, { code: string; message: string }> = {
  '4000000000000002': { code: 'card_declined', message: 'Your card was declined' },
  '4000000000000069': { code: 'expired_card', message: 'Your card has expired' },
  '4000000000000119': { code: 'processing_error', message: 'An error occurred while processing your card' },
};

const APPROVED = '4242424242424242';

function normalise(cardNumber: string): string {
  return cardNumber.replace(/[\s-]/g, '');
}

function isExpired(expMonth: number, expYear: number): boolean {
  const now = new Date();
  const endOfMonth = new Date(Date.UTC(expYear, expMonth, 1));
  return endOfMonth <= now;
}

async function simulateLatency(): Promise<void> {
  // A real gateway is not instantaneous; a small delay keeps the frontend's
  // loading states honest.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async charge(request: PaymentRequest): Promise<PaymentResult> {
    await simulateLatency();

    const card = normalise(request.details.cardNumber);
    const last4 = card.slice(-4);
    const base = {
      simulated: true,
      orderNumber: request.orderNumber,
      amountCents: request.amountCents,
      currency: request.currency,
      last4,
      processedAt: new Date().toISOString(),
    };

    if (isExpired(request.details.expMonth, request.details.expYear)) {
      return {
        outcome: 'FAILED',
        failureCode: 'expired_card',
        failureMessage: 'Your card has expired',
        raw: { ...base, decision: 'declined' },
      };
    }

    const scripted = SCRIPTED[card];
    if (scripted) {
      return {
        outcome: 'FAILED',
        failureCode: scripted.code,
        failureMessage: scripted.message,
        raw: { ...base, decision: 'declined' },
      };
    }

    const lastDigit = Number(card.slice(-1));
    const approved = card === APPROVED || (Number.isFinite(lastDigit) && lastDigit % 2 === 0);

    if (!approved) {
      return {
        outcome: 'FAILED',
        failureCode: 'card_declined',
        failureMessage: 'Your card was declined',
        raw: { ...base, decision: 'declined' },
      };
    }

    return {
      outcome: 'CAPTURED',
      providerRef: `mock_ch_${crypto.randomBytes(10).toString('hex')}`,
      raw: { ...base, decision: 'approved' },
    };
  }

  async refund(providerRef: string, amountCents: number): Promise<PaymentResult> {
    await simulateLatency();
    return {
      outcome: 'CAPTURED',
      providerRef: `mock_re_${crypto.randomBytes(10).toString('hex')}`,
      raw: { simulated: true, refundOf: providerRef, amountCents, refundedAt: new Date().toISOString() },
    };
  }
}
