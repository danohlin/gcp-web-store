import { config } from '../config/index.js';

export interface LineTotal {
  unitPriceCents: number;
  quantity: number;
}

export interface OrderTotals {
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Mock shipping and tax rules, deliberately isolated so that swapping in a real
 * tax service (or per-destination shipping rates) touches only this file.
 *
 * All arithmetic is on integer cents; the only rounding happens once, on tax.
 */
export function calculateTotals(lines: LineTotal[]): OrderTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);

  const shippingCents =
    subtotalCents === 0 || subtotalCents >= config.freeShippingThresholdCents
      ? 0
      : config.shippingFlatCents;

  // Tax applies to goods only, not shipping. Round half-up.
  const taxCents = Math.round((subtotalCents * config.taxRateBasisPoints) / 10_000);

  return {
    subtotalCents,
    shippingCents,
    taxCents,
    totalCents: subtotalCents + shippingCents + taxCents,
  };
}

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
