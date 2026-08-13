import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { agent, app, createProduct, createUser, signedInAgent } from './helpers.js';
import { prisma } from '../src/lib/prisma.js';

describe('guest cart', () => {
  it('starts empty and issues a cart cookie', async () => {
    const res = await request(app).get('/api/cart').expect(200);

    expect(res.body.items).toEqual([]);
    expect(res.body.itemCount).toBe(0);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('cart_token=') && c.includes('HttpOnly'))).toBe(true);
  });

  it('persists across requests via the cookie', async () => {
    const product = await createProduct({ priceCents: 2500 });
    const client = agent();

    await client.post('/api/cart/items').send({ productId: product.id, quantity: 2 }).expect(201);

    const res = await client.get('/api/cart').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(2);
    expect(res.body.subtotalCents).toBe(5000);
  });

  it('does not leak between separate visitors', async () => {
    const product = await createProduct();
    const first = agent();
    await first.post('/api/cart/items').send({ productId: product.id }).expect(201);

    const second = agent();
    const res = await second.get('/api/cart').expect(200);
    expect(res.body.items).toEqual([]);
  });

  it('accumulates quantity when the same product is added twice', async () => {
    const product = await createProduct({ stockQty: 10 });
    const client = agent();

    await client.post('/api/cart/items').send({ productId: product.id, quantity: 2 }).expect(201);
    const res = await client
      .post('/api/cart/items')
      .send({ productId: product.id, quantity: 3 })
      .expect(201);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(5);
  });

  it('refuses to add more than available stock', async () => {
    const product = await createProduct({ stockQty: 3, name: 'Scarce Item' });
    const client = agent();

    const res = await client
      .post('/api/cart/items')
      .send({ productId: product.id, quantity: 4 })
      .expect(409);

    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details.available).toBe(3);
  });

  it('updates and removes lines', async () => {
    const product = await createProduct({ stockQty: 10, priceCents: 1000 });
    const client = agent();

    const added = await client
      .post('/api/cart/items')
      .send({ productId: product.id, quantity: 2 })
      .expect(201);
    const itemId = added.body.items[0].id;

    const updated = await client
      .patch(`/api/cart/items/${itemId}`)
      .send({ quantity: 4 })
      .expect(200);
    expect(updated.body.items[0].quantity).toBe(4);
    expect(updated.body.subtotalCents).toBe(4000);

    const removed = await client.delete(`/api/cart/items/${itemId}`).expect(200);
    expect(removed.body.items).toEqual([]);
  });

  it('treats a quantity of zero as a removal', async () => {
    const product = await createProduct({ stockQty: 10 });
    const client = agent();

    const added = await client.post('/api/cart/items').send({ productId: product.id }).expect(201);
    const res = await client
      .patch(`/api/cart/items/${added.body.items[0].id}`)
      .send({ quantity: 0 })
      .expect(200);

    expect(res.body.items).toEqual([]);
  });

  it('404s for an unknown product', async () => {
    await request(app)
      .post('/api/cart/items')
      .send({ productId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
  });
});

describe('cart pricing', () => {
  it('reprices from the live product, not a stored snapshot', async () => {
    const product = await createProduct({ priceCents: 1000, stockQty: 10 });
    const client = agent();
    await client.post('/api/cart/items').send({ productId: product.id, quantity: 2 }).expect(201);

    await prisma.product.update({ where: { id: product.id }, data: { priceCents: 1500 } });

    const res = await client.get('/api/cart').expect(200);
    expect(res.body.items[0].unitPriceCents).toBe(1500);
    expect(res.body.subtotalCents).toBe(3000);
  });

  it('applies shipping below the free threshold and tax on goods only', async () => {
    // Threshold is 5000 cents, flat shipping 599, tax 8.75%.
    const product = await createProduct({ priceCents: 1000, stockQty: 10 });
    const client = agent();
    await client.post('/api/cart/items').send({ productId: product.id, quantity: 2 }).expect(201);

    const res = await client.get('/api/cart').expect(200);
    expect(res.body.subtotalCents).toBe(2000);
    expect(res.body.shippingCents).toBe(599);
    expect(res.body.taxCents).toBe(175); // round(2000 * 0.0875)
    expect(res.body.totalCents).toBe(2774);
  });

  it('waives shipping at or above the free threshold', async () => {
    const product = await createProduct({ priceCents: 5000, stockQty: 10 });
    const client = agent();
    await client.post('/api/cart/items').send({ productId: product.id }).expect(201);

    const res = await client.get('/api/cart').expect(200);
    expect(res.body.shippingCents).toBe(0);
  });

  it('flags a line that has outrun its stock', async () => {
    const product = await createProduct({ stockQty: 5 });
    const client = agent();
    await client.post('/api/cart/items').send({ productId: product.id, quantity: 5 }).expect(201);

    await prisma.product.update({ where: { id: product.id }, data: { stockQty: 2 } });

    const res = await client.get('/api/cart').expect(200);
    expect(res.body.items[0].exceedsStock).toBe(true);
    expect(res.body.hasIssues).toBe(true);
  });
});

describe('guest cart merge on sign-in', () => {
  it('folds the guest cart into the user cart', async () => {
    const productA = await createProduct({ stockQty: 10 });
    const productB = await createProduct({ stockQty: 10 });

    // Signed-in user already has product A in their cart.
    const { client: user } = await signedInAgent({
      email: 'merge@example.com',
      password: 'correct-horse-battery',
    });
    await user.post('/api/cart/items').send({ productId: productA.id, quantity: 1 }).expect(201);
    await user.post('/api/auth/logout').expect(204);

    // As a guest, they add more of A plus some B.
    const guest = agent();
    await guest.post('/api/cart/items').send({ productId: productA.id, quantity: 2 }).expect(201);
    await guest.post('/api/cart/items').send({ productId: productB.id, quantity: 3 }).expect(201);

    const signedIn = await guest
      .post('/api/auth/login')
      .send({ email: 'merge@example.com', password: 'correct-horse-battery' })
      .expect(200);
    guest.set('Authorization', `Bearer ${signedIn.body.accessToken}`);

    const merged = await guest.get('/api/cart').expect(200);

    const byId = Object.fromEntries(
      merged.body.items.map((i: { productId: string; quantity: number }) => [
        i.productId,
        i.quantity,
      ]),
    );
    // Quantities are summed, not overwritten.
    expect(byId[productA.id]).toBe(3);
    expect(byId[productB.id]).toBe(3);
  });

  it('caps the merged quantity at available stock', async () => {
    const product = await createProduct({ stockQty: 4 });

    const { client: user } = await signedInAgent({
      email: 'cap@example.com',
      password: 'correct-horse-battery',
    });
    await user.post('/api/cart/items').send({ productId: product.id, quantity: 3 }).expect(201);
    await user.post('/api/auth/logout').expect(204);

    const guest = agent();
    await guest.post('/api/cart/items').send({ productId: product.id, quantity: 3 }).expect(201);

    const signedIn = await guest
      .post('/api/auth/login')
      .send({ email: 'cap@example.com', password: 'correct-horse-battery' })
      .expect(200);
    guest.set('Authorization', `Bearer ${signedIn.body.accessToken}`);

    const merged = await guest.get('/api/cart').expect(200);
    // 3 + 3 would be 6, but only 4 exist.
    expect(merged.body.items[0].quantity).toBe(4);
    expect(merged.body.hasIssues).toBe(false);
  });

  it('retires the guest cart so a stale cookie cannot resurrect it', async () => {
    const product = await createProduct({ stockQty: 10 });
    const guest = agent();
    const added = await guest
      .post('/api/cart/items')
      .send({ productId: product.id })
      .expect(201);

    const cookies = added.headers['set-cookie'] as unknown as string[];
    const staleCookie = cookies.find((c) => c.startsWith('cart_token='))!.split(';')[0]!;

    await createUser({ email: 'convert@example.com', password: 'correct-horse-battery' });
    await guest
      .post('/api/auth/login')
      .send({ email: 'convert@example.com', password: 'correct-horse-battery' })
      .expect(200);

    const converted = await prisma.cart.findFirst({ where: { status: 'CONVERTED' } });
    expect(converted).not.toBeNull();
    // The token is retained: it records the visit the cart came from, and every
    // cart must keep an owner.
    expect(converted!.sessionToken).not.toBeNull();

    // Someone returning with the old cookie gets a fresh cart, not the retired
    // one, because only ACTIVE carts are ever matched.
    const returning = await request(app)
      .get('/api/cart')
      .set('Cookie', staleCookie)
      .expect(200);

    expect(returning.body.items).toEqual([]);
    expect(returning.body.id).not.toBe(converted!.id);
  });
});
