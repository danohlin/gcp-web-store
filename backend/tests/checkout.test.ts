import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ADDRESS,
  DECLINED_CARD,
  VALID_CARD,
  agent,
  app,
  createProduct,
  signedInAgent,
} from './helpers.js';
import { prisma } from '../src/lib/prisma.js';

const GUEST_ORDER = {
  email: 'guest@example.com',
  shippingAddress: ADDRESS,
  payment: VALID_CARD,
};

async function cartWith(client: ReturnType<typeof agent>, productId: string, quantity = 1) {
  await client.post('/api/cart/items').send({ productId, quantity }).expect(201);
}

describe('POST /api/checkout/quote', () => {
  it('reports totals and whether checkout can proceed', async () => {
    const product = await createProduct({ priceCents: 1000, stockQty: 10 });
    const client = agent();
    await cartWith(client, product.id, 2);

    const res = await client.post('/api/checkout/quote').expect(200);

    expect(res.body.subtotalCents).toBe(2000);
    expect(res.body.canCheckout).toBe(true);
  });

  it('blocks checkout on an empty cart', async () => {
    const res = await request(app).post('/api/checkout/quote').expect(200);
    expect(res.body.canCheckout).toBe(false);
  });

  it('blocks checkout when a line exceeds stock', async () => {
    const product = await createProduct({ stockQty: 5 });
    const client = agent();
    await cartWith(client, product.id, 5);

    await prisma.product.update({ where: { id: product.id }, data: { stockQty: 1 } });

    const res = await client.post('/api/checkout/quote').expect(200);
    expect(res.body.canCheckout).toBe(false);
  });
});

describe('guest checkout', () => {
  it('places an order, decrements stock and clears the cart', async () => {
    const product = await createProduct({ priceCents: 2000, stockQty: 10 });
    const client = agent();
    await cartWith(client, product.id, 3);

    const res = await client.post('/api/checkout/orders').send(GUEST_ORDER).expect(201);

    const order = res.body.order;
    expect(order.status).toBe('PAID');
    expect(order.orderNumber).toMatch(/^WS-\d{8}-[A-Z0-9]{5}$/);
    expect(order.email).toBe('guest@example.com');
    expect(order.items).toHaveLength(1);
    expect(order.items[0].quantity).toBe(3);
    expect(order.subtotalCents).toBe(6000);
    expect(order.payment.status).toBe('CAPTURED');
    expect(order.payment.reference).toMatch(/^mock_ch_/);

    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after!.stockQty).toBe(7);

    const cart = await client.get('/api/cart').expect(200);
    expect(cart.body.items).toEqual([]);
  });

  it('snapshots product details onto the order line', async () => {
    const product = await createProduct({ name: 'Original Name', priceCents: 1000, stockQty: 5 });
    const client = agent();
    await cartWith(client, product.id, 1);
    await client.post('/api/checkout/orders').send(GUEST_ORDER).expect(201);

    await prisma.product.update({
      where: { id: product.id },
      data: { name: 'Renamed Later', priceCents: 9999 },
    });

    const line = await prisma.orderItem.findFirst();
    // History must not move when the catalogue changes.
    expect(line!.productName).toBe('Original Name');
    expect(line!.unitPriceCents).toBe(1000);
  });

  it('never trusts a client-supplied price', async () => {
    const product = await createProduct({ priceCents: 5000, stockQty: 5 });
    const client = agent();
    await cartWith(client, product.id, 1);

    const res = await client
      .post('/api/checkout/orders')
      .send({ ...GUEST_ORDER, subtotalCents: 1, totalCents: 1 })
      .expect(201);

    expect(res.body.order.subtotalCents).toBe(5000);
  });

  it('requires an email for a guest', async () => {
    const product = await createProduct({ stockQty: 5 });
    const client = agent();
    await cartWith(client, product.id);

    const res = await client
      .post('/api/checkout/orders')
      .send({ shippingAddress: ADDRESS, payment: VALID_CARD })
      .expect(400);

    expect(res.body.error.message).toMatch(/email/i);
  });

  it('rejects an empty cart', async () => {
    const res = await request(app).post('/api/checkout/orders').send(GUEST_ORDER).expect(400);
    expect(res.body.error.message).toMatch(/empty/i);
  });
});

describe('declined payment', () => {
  it('cancels the order, restores stock and leaves the cart intact', async () => {
    const product = await createProduct({ priceCents: 2000, stockQty: 10 });
    const client = agent();
    await cartWith(client, product.id, 4);

    const res = await client
      .post('/api/checkout/orders')
      .send({ ...GUEST_ORDER, payment: DECLINED_CARD })
      .expect(402);

    expect(res.body.error.code).toBe('PAYMENT_DECLINED');

    // Stock is returned to the shelf.
    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after!.stockQty).toBe(10);

    const order = await prisma.order.findFirst();
    expect(order!.status).toBe('CANCELLED');
    expect(order!.cancelledAt).not.toBeNull();

    const payment = await prisma.payment.findFirst();
    expect(payment!.status).toBe('FAILED');
    expect(payment!.failureCode).toBe('card_declined');

    // The customer can simply try again.
    const cart = await client.get('/api/cart').expect(200);
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.items[0].quantity).toBe(4);
  });

  it('declines an expired card', async () => {
    const product = await createProduct({ stockQty: 5 });
    const client = agent();
    await cartWith(client, product.id);

    const res = await client
      .post('/api/checkout/orders')
      .send({ ...GUEST_ORDER, payment: { ...VALID_CARD, expMonth: 1, expYear: 2020 } })
      .expect(402);

    expect(res.body.error.details.failureCode).toBe('expired_card');
  });

  it('never persists card details', async () => {
    const product = await createProduct({ stockQty: 5 });
    const client = agent();
    await cartWith(client, product.id);
    await client.post('/api/checkout/orders').send(GUEST_ORDER).expect(201);

    const payment = await prisma.payment.findFirst();
    const serialised = JSON.stringify(payment);
    expect(serialised).not.toContain(VALID_CARD.cardNumber);
    expect(serialised).not.toContain(VALID_CARD.cvc);
    // Only the last four digits are retained, as a gateway would.
    expect(serialised).toContain('4242');
  });
});

describe('stock safety', () => {
  it('refuses to oversell when stock ran out after the cart was filled', async () => {
    const product = await createProduct({ stockQty: 5, name: 'Last One' });
    const client = agent();
    await cartWith(client, product.id, 5);

    // Someone else buys the stock in the meantime.
    await prisma.product.update({ where: { id: product.id }, data: { stockQty: 1 } });

    const res = await client.post('/api/checkout/orders').send(GUEST_ORDER).expect(409);

    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    // The failed attempt must not have consumed the remaining unit.
    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after!.stockQty).toBe(1);
    expect(await prisma.order.count()).toBe(0);
  });

  it('lets only one of two concurrent checkouts win the last unit', async () => {
    const product = await createProduct({ stockQty: 1, name: 'Single Unit' });

    const first = agent();
    const second = agent();
    await cartWith(first, product.id, 1);
    await cartWith(second, product.id, 1);

    const results = await Promise.allSettled([
      first.post('/api/checkout/orders').send(GUEST_ORDER),
      second.post('/api/checkout/orders').send(GUEST_ORDER),
    ]);

    const statuses = results
      .map((r) => (r.status === 'fulfilled' ? r.value.status : 500))
      .sort((a, b) => a - b);

    expect(statuses).toEqual([201, 409]);

    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after!.stockQty).toBe(0);
    expect(await prisma.order.count({ where: { status: 'PAID' } })).toBe(1);
  });
});

describe('signed-in checkout and order history', () => {
  it('attaches the order to the account and lists it in history', async () => {
    const product = await createProduct({ priceCents: 1500, stockQty: 10 });
    const { client, accessToken } = await signedInAgent({
      email: 'buyer@example.com',
      password: 'correct-horse-battery',
    });
    await cartWith(client, product.id, 2);

    const placed = await client
      .post('/api/checkout/orders')
      .send({ shippingAddress: ADDRESS, payment: VALID_CARD })
      .expect(201);

    // Email defaults to the account's address.
    expect(placed.body.order.email).toBe('buyer@example.com');

    const history = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].orderNumber).toBe(placed.body.order.orderNumber);
  });

  it('refuses to show one customer another customer’s order', async () => {
    const product = await createProduct({ stockQty: 10 });
    const buyer = await signedInAgent({
      email: 'buyer@example.com',
      password: 'correct-horse-battery',
    });
    await cartWith(buyer.client, product.id);
    const placed = await buyer.client
      .post('/api/checkout/orders')
      .send({ shippingAddress: ADDRESS, payment: VALID_CARD })
      .expect(201);

    const other = await signedInAgent({
      email: 'nosy@example.com',
      password: 'correct-horse-battery',
    });

    const res = await request(app)
      .get(`/api/orders/${placed.body.order.orderNumber}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requires authentication for order history', async () => {
    await request(app).get('/api/orders').expect(401);
  });
});
