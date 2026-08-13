import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/password.js';

export const app: Express = createApp();

/** A supertest agent persists cookies across requests, like a browser. */
export function agent() {
  return request.agent(app);
}

export const VALID_CARD = {
  cardNumber: '4242424242424242',
  expMonth: 12,
  expYear: new Date().getFullYear() + 3,
  cvc: '123',
  nameOnCard: 'Sam Shopper',
};

export const DECLINED_CARD = { ...VALID_CARD, cardNumber: '4000000000000002' };

export const ADDRESS = {
  fullName: 'Sam Shopper',
  line1: '1 Example Street',
  city: 'Portland',
  region: 'OR',
  postalCode: '97201',
  country: 'US',
};

export async function createUser(opts: {
  email: string;
  password: string;
  role?: 'CUSTOMER' | 'ADMIN';
}) {
  return prisma.user.create({
    data: {
      email: opts.email.toLowerCase(),
      passwordHash: await hashPassword(opts.password),
      role: opts.role ?? 'CUSTOMER',
    },
  });
}

/** Creates a user and returns an agent already holding their session. */
export async function signedInAgent(opts: {
  email: string;
  password: string;
  role?: 'CUSTOMER' | 'ADMIN';
}) {
  await createUser(opts);
  const client = agent();
  const res = await client
    .post('/api/auth/login')
    .send({ email: opts.email, password: opts.password })
    .expect(200);

  const accessToken = res.body.accessToken as string;
  // Registered as an agent default so every later request on this client is
  // authenticated, mirroring a browser that holds the token in memory.
  client.set('Authorization', `Bearer ${accessToken}`);

  return { client, accessToken, user: res.body.user };
}

export async function createCategory(slug: string, name = slug) {
  return prisma.category.create({ data: { slug, name } });
}

export async function createProduct(overrides: {
  sku?: string;
  slug?: string;
  name?: string;
  description?: string;
  priceCents?: number;
  stockQty?: number;
  isActive?: boolean;
  categoryIds?: string[];
} = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { categoryIds, ...rest } = overrides;

  return prisma.product.create({
    data: {
      sku: rest.sku ?? `SKU-${suffix}`,
      slug: rest.slug ?? `product-${suffix}`,
      name: rest.name ?? 'Test Product',
      description: rest.description ?? 'A product used in tests',
      priceCents: rest.priceCents ?? 1000,
      stockQty: rest.stockQty ?? 10,
      isActive: rest.isActive ?? true,
      ...(categoryIds?.length
        ? { categories: { create: categoryIds.map((categoryId) => ({ categoryId })) } }
        : {}),
    },
  });
}
