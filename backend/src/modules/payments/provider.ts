/**
 * Payment gateway abstraction.
 *
 * Nothing outside this folder knows which gateway is in use. Adding Stripe or
 * Adyen later means implementing this interface and registering it in
 * `index.ts` — the checkout service does not change.
 */

export interface PaymentDetails {
  cardNumber: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  nameOnCard: string;
}

export interface PaymentRequest {
  orderId: string;
  orderNumber: string;
  amountCents: number;
  currency: string;
  details: PaymentDetails;
}

export type PaymentOutcome = 'AUTHORIZED' | 'CAPTURED' | 'FAILED';

export interface PaymentResult {
  outcome: PaymentOutcome;
  providerRef?: string;
  failureCode?: string;
  failureMessage?: string;
  /** Stored verbatim on the payment record for support and reconciliation. */
  raw: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  /**
   * Authorises and captures in one step. A real gateway would likely split
   * these; the interface leaves room for that without changing callers.
   */
  charge(request: PaymentRequest): Promise<PaymentResult>;
  refund(providerRef: string, amountCents: number): Promise<PaymentResult>;
}
