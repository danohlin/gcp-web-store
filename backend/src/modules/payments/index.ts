import { config } from '../../config/index.js';
import { MockPaymentProvider } from './mock.provider.js';
import type { PaymentProvider } from './provider.js';

const registry: Record<string, () => PaymentProvider> = {
  mock: () => new MockPaymentProvider(),
};

function build(): PaymentProvider {
  const factory = registry[config.paymentProvider];
  if (!factory) {
    throw new Error(`Unknown payment provider "${config.paymentProvider}"`);
  }
  return factory();
}

export const paymentProvider: PaymentProvider = build();

export type {
  PaymentDetails,
  PaymentProvider,
  PaymentRequest,
  PaymentResult,
  PaymentOutcome,
} from './provider.js';
