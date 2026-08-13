import { z } from 'zod';
import { OrderStatus } from '@prisma/client';

const slug = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may contain lowercase letters, numbers and hyphens');

export const imageSchema = z.object({
  url: z.string().trim().url().max(500),
  alt: z.string().trim().max(200).default(''),
  position: z.coerce.number().int().min(0).default(0),
});

export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  // Derived from the name when omitted.
  slug: slug.optional(),
  description: z.string().trim().max(5000).default(''),
  priceCents: z.coerce.number().int().nonnegative(),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  stockQty: z.coerce.number().int().nonnegative().default(0),
  isActive: z.boolean().default(true),
  categoryIds: z.array(z.string().uuid()).default([]),
  images: z.array(imageSchema).default([]),
});

// Every field optional, but at least one must be present.
export const updateProductSchema = createProductSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slug.optional(),
  description: z.string().trim().max(1000).optional(),
  parentId: z.string().uuid().nullable().optional(),
  position: z.coerce.number().int().min(0).default(0),
});

export const updateCategorySchema = createCategorySchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const adminProductQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  includeInactive: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v)),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const adminOrderQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  email: z.string().trim().toLowerCase().max(254).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const updateOrderStatusSchema = z.object({
  status: z.nativeEnum(OrderStatus),
});

export const idParamsSchema = z.object({ id: z.string().uuid() });

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type AdminProductQuery = z.infer<typeof adminProductQuerySchema>;
export type AdminOrderQuery = z.infer<typeof adminOrderQuerySchema>;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining diacritical marks left behind by NFKD (café -> cafe).
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}
