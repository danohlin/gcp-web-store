import { z } from 'zod';

export const addressSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().min(1).max(32),
  country: z.string().trim().length(2, 'Use a 2-letter ISO country code').toUpperCase(),
  phone: z.string().trim().max(40).optional(),
});

/**
 * Card details are accepted, handed straight to the (mock) gateway, and never
 * persisted. With a real gateway this shape would be replaced by a
 * client-side-tokenised reference so raw PAN never reaches the server at all.
 */
export const paymentDetailsSchema = z.object({
  cardNumber: z
    .string()
    .trim()
    .regex(/^[0-9][0-9 -]{10,24}$/, 'Enter a valid card number'),
  expMonth: z.coerce.number().int().min(1).max(12),
  expYear: z.coerce.number().int().min(2000).max(2100),
  cvc: z.string().trim().regex(/^[0-9]{3,4}$/, 'Enter a valid security code'),
  nameOnCard: z.string().trim().min(1).max(120),
});

export const createOrderSchema = z.object({
  // Required for guest checkout; defaults to the signed-in user's address.
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  payment: paymentDetailsSchema,
});

export const orderNumberParamsSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .regex(/^WS-\d{8}-[A-Z0-9]{5}$/, 'Invalid order number'),
});

export type AddressInput = z.infer<typeof addressSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
