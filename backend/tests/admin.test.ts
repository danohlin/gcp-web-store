import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ADDRESS,
  VALID_CARD,
  agent,
  app,
  createCategory,
  createProduct,
  signedInAgent,
} from './helpers.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery', role: 'ADMIN' as const };
const CUSTOMER = { email: 'customer@example.com', password: 'correct-horse-battery' };

async function adminToken() {
  const { accessToken } = await signedInAgent(ADMIN);
  return accessToken;
}

describe('admin access control', () => {
  it('rejects anonymous callers', async () => {
    await request(app).get('/api/admin/products').expect(401);
  });

  it('rejects a signed-in non-admin', async () => {
    const { accessToken } = await signedInAgent(CUSTOMER);
    const res = await request(app)
      .get('/api/admin/products')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows an admin', async () => {
    const token = await adminToken();
    await request(app)
      .get('/api/admin/products')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});

describe('admin product management', () => {
  it('creates a product, deriving the slug from the name', async () => {
    const token = await adminToken();
    const category = await createCategory('audio', 'Audio');

    const res = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sku: 'WS-NEW-001',
        name: 'Aurora Over-Ear Headphones',
        description: 'Wireless with noise cancelling',
        priceCents: 24999,
        stockQty: 10,
        categoryIds: [category.id],
        images: [{ url: 'https://example.com/a.jpg', alt: 'Front', position: 0 }],
      })
      .expect(201);

    expect(res.body.slug).toBe('aurora-over-ear-headphones');
    expect(res.body.images).toHaveLength(1);
    expect(res.body.categories).toHaveLength(1);
  });

  it('makes a new product searchable immediately', async () => {
    const token = await adminToken();
    await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'WS-NEW-002', name: 'Meridian Turntable', priceCents: 44900, stockQty: 3 })
      .expect(201);

    // The tsvector trigger must have fired on insert.
    const res = await request(app).get('/api/products?q=turntable').expect(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('keeps search in step after a rename', async () => {
    const token = await adminToken();
    const product = await createProduct({ name: 'Old Widget' });

    await request(app)
      .patch(`/api/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refurbished Gramophone' })
      .expect(200);

    await request(app).get('/api/products?q=gramophone').expect(200).expect((res) => {
      expect(res.body.items).toHaveLength(1);
    });
    await request(app).get('/api/products?q=widget').expect(200).expect((res) => {
      expect(res.body.items).toHaveLength(0);
    });
  });

  it('rejects a duplicate SKU', async () => {
    const token = await adminToken();
    await createProduct({ sku: 'WS-DUP-001' });

    const res = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'WS-DUP-001', name: 'Another', priceCents: 100 })
      .expect(409);

    expect(res.body.error.code).toBe('DUPLICATE');
  });

  it('rejects a category that does not exist', async () => {
    const token = await adminToken();
    await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sku: 'WS-BAD-001',
        name: 'Orphan',
        priceCents: 100,
        categoryIds: ['00000000-0000-0000-0000-000000000000'],
      })
      .expect(400);
  });

  it('retires rather than destroys a product, and pulls it from live carts', async () => {
    const token = await adminToken();
    const product = await createProduct({ stockQty: 10 });

    const shopper = agent();
    await shopper.post('/api/cart/items').send({ productId: product.id }).expect(201);

    await request(app)
      .delete(`/api/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The row survives, so order history keeps its reference.
    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored).not.toBeNull();
    expect(stored!.isActive).toBe(false);

    await request(app).get(`/api/products/${product.slug}`).expect(404);

    const cart = await shopper.get('/api/cart').expect(200);
    expect(cart.body.items).toEqual([]);
  });

  it('lists inactive products only when asked', async () => {
    const token = await adminToken();
    await createProduct({ name: 'Live' });
    await createProduct({ name: 'Retired', isActive: false });

    const activeOnly = await request(app)
      .get('/api/admin/products')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(activeOnly.body.items).toHaveLength(1);

    const all = await request(app)
      .get('/api/admin/products?includeInactive=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(all.body.items).toHaveLength(2);
  });
});

describe('admin category management', () => {
  it('refuses a parent that would create a cycle', async () => {
    const token = await adminToken();
    const parent = await createCategory('electronics', 'Electronics');
    const child = await prisma.category.create({
      data: { slug: 'audio', name: 'Audio', parentId: parent.id },
    });

    const res = await request(app)
      .patch(`/api/admin/categories/${parent.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentId: child.id })
      .expect(400);

    expect(res.body.error.message).toMatch(/cycle/i);
  });

  it('refuses to delete a category that still has children', async () => {
    const token = await adminToken();
    const parent = await createCategory('electronics', 'Electronics');
    await prisma.category.create({ data: { slug: 'audio', name: 'Audio', parentId: parent.id } });

    const res = await request(app)
      .delete(`/api/admin/categories/${parent.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    expect(res.body.error.code).toBe('CATEGORY_HAS_CHILDREN');
  });
});

describe('admin order management', () => {
  async function placeOrder() {
    const product = await createProduct({ priceCents: 1000, stockQty: 10 });
    const client = agent();
    await client.post('/api/cart/items').send({ productId: product.id, quantity: 2 }).expect(201);
    const res = await client
      .post('/api/checkout/orders')
      .send({ email: 'guest@example.com', shippingAddress: ADDRESS, payment: VALID_CARD })
      .expect(201);
    return { orderId: res.body.order.id as string, productId: product.id };
  }

  it('advances an order through valid statuses', async () => {
    const token = await adminToken();
    const { orderId } = await placeOrder();

    for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
      const res = await request(app)
        .patch(`/api/admin/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status })
        .expect(200);
      expect(res.body.status).toBe(status);
    }
  });

  it('rejects an illegal transition', async () => {
    const token = await adminToken();
    const { orderId } = await placeOrder();

    // PAID cannot jump straight to DELIVERED.
    const res = await request(app)
      .patch(`/api/admin/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'DELIVERED' })
      .expect(409);

    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('returns stock when an order is cancelled', async () => {
    const token = await adminToken();
    const { orderId, productId } = await placeOrder();

    const before = await prisma.product.findUnique({ where: { id: productId } });
    expect(before!.stockQty).toBe(8);

    await request(app)
      .patch(`/api/admin/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'CANCELLED' })
      .expect(200);

    const after = await prisma.product.findUnique({ where: { id: productId } });
    expect(after!.stockQty).toBe(10);
  });

  it('treats cancelled as terminal', async () => {
    const token = await adminToken();
    const { orderId } = await placeOrder();

    await request(app)
      .patch(`/api/admin/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'CANCELLED' })
      .expect(200);

    await request(app)
      .patch(`/api/admin/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'PROCESSING' })
      .expect(409);
  });

  it('filters orders by status', async () => {
    const token = await adminToken();
    await placeOrder();

    const paid = await request(app)
      .get('/api/admin/orders?status=PAID')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(paid.body.items).toHaveLength(1);

    const shipped = await request(app)
      .get('/api/admin/orders?status=SHIPPED')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(shipped.body.items).toHaveLength(0);
  });
});
