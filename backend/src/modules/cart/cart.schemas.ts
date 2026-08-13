import { z } from 'zod';

export const addItemSchema = z.object({
  productId: z.string().uuid('productId must be a valid id'),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
});

export const updateItemSchema = z.object({
  // Zero is allowed and removes the line, which matches how quantity steppers
  // behave in the UI.
  quantity: z.coerce.number().int().min(0).max(99),
});

export const itemParamsSchema = z.object({
  itemId: z.string().uuid(),
});

export type AddItemInput = z.infer<typeof addItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
