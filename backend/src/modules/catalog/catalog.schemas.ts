import { z } from 'zod';

export const SORT_OPTIONS = ['relevance', 'newest', 'price_asc', 'price_desc', 'name_asc'] as const;

export const productQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(120).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(SORT_OPTIONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(24),
  inStockOnly: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v)),
});

export const slugParamsSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9-]+$/, 'Invalid slug'),
});

export type ProductQuery = z.infer<typeof productQuerySchema>;
