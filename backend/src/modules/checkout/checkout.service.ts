import type { Order, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { calculateTotals } from '../../lib/money.js';
import { generateOrderNumber } from '../../lib/tokens.js';
import {
  BadRequestError,
  ConflictError,
  InsufficientStockError,
  PaymentDeclinedError,
} from '../../lib/errors.js';
import { paymentProvider } from '../payments/index.js';
import { getCartView, type CartView } from '../cart/cart.service.js';
import type { CreateOrderInput } from './checkout.schemas.js';

/**
 * The payment provider interface stays free of Prisma types, so gateway
 * responses are narrowed to Prisma's JSON input shape only at this boundary.
 */
function asJson(value: Record<string, unknown>): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

export interface Quote extends CartView {
  /** False when a line is out of stock or the cart is empty. */
  canCheckout: boolean;
}

export async function quote(cartId: string): Promise<Quote> {
  const cart = await getCartView(cartId);
  return { ...cart, canCheckout: cart.items.length > 0 && !cart.hasIssues };
}

/**
 * Places an order.
 *
 * The sequence is deliberately three steps rather than one transaction:
 *
 *   1. Reserve — inside a transaction, re-price from live product rows,
 *      conditionally decrement stock, and persist the order as PENDING_PAYMENT.
 *   2. Charge — call the gateway with no database transaction open, so a slow
 *      or hanging gateway never holds row locks.
 *   3. Settle — record the outcome, and on decline put the stock back and
 *      cancel the order. The cart is left ACTIVE until payment succeeds so a
 *      declined customer can simply retry.
 */
export async function createOrder(
  cartId: string,
  input: CreateOrderInput,
  user?: { id: string; email: string },
): Promise<{ order: Order; itemCount: number }> {
  const email = user?.email ?? input.email;
  if (!email) {
    throw new BadRequestError('An email address is required to place an order');
  }

  // ---- 1. Reserve -------------------------------------------------------
  const reserved = await prisma.$transaction(async (tx) => {
    const cart = await tx.cart.findUnique({
      where: { id: cartId },
      include: { items: { include: { product: true } } },
    });

    if (!cart || cart.status !== 'ACTIVE') {
      throw new ConflictError('This cart is no longer active', 'CART_NOT_ACTIVE');
    }
    if (cart.items.length === 0) {
      throw new BadRequestError('Your cart is empty');
    }

    for (const item of cart.items) {
      if (!item.product.isActive) {
        throw new ConflictError(
          `"${item.product.name}" is no longer available`,
          'PRODUCT_UNAVAILABLE',
        );
      }

      // Conditional decrement: if a concurrent order took the last unit, the
      // WHERE clause matches nothing and count is 0. This is the whole
      // oversell guard — no read-then-write race.
      const { count } = await tx.product.updateMany({
        where: { id: item.productId, stockQty: { gte: item.quantity } },
        data: { stockQty: { decrement: item.quantity } },
      });

      if (count === 0) {
        const current = await tx.product.findUnique({ where: { id: item.productId } });
        throw new InsufficientStockError(item.product.name, current?.stockQty ?? 0);
      }
    }

    // Prices come from the product rows just read, not from the client.
    const totals = calculateTotals(
      cart.items.map((i) => ({ unitPriceCents: i.product.priceCents, quantity: i.quantity })),
    );

    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId: user?.id ?? null,
        email,
        status: 'PENDING_PAYMENT',
        subtotalCents: totals.subtotalCents,
        shippingCents: totals.shippingCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        currency: cart.items[0]?.product.currency ?? 'USD',
        shippingAddress: input.shippingAddress,
        billingAddress: input.billingAddress ?? input.shippingAddress,
        items: {
          create: cart.items.map((i) => ({
            productId: i.productId,
            productName: i.product.name,
            sku: i.product.sku,
            unitPriceCents: i.product.priceCents,
            quantity: i.quantity,
            lineTotalCents: i.product.priceCents * i.quantity,
          })),
        },
        payments: {
          create: {
            provider: paymentProvider.name,
            amountCents: totals.totalCents,
            currency: cart.items[0]?.product.currency ?? 'USD',
            status: 'PENDING',
          },
        },
      },
      include: { items: true, payments: true },
    });

    return order;
  });

  // ---- 2. Charge --------------------------------------------------------
  const paymentRecord = reserved.payments[0]!;
  let result;
  try {
    result = await paymentProvider.charge({
      orderId: reserved.id,
      orderNumber: reserved.orderNumber,
      amountCents: reserved.totalCents,
      currency: reserved.currency,
      details: input.payment,
    });
  } catch (err) {
    logger.error({ err, orderId: reserved.id }, 'payment provider threw; releasing reservation');
    await releaseReservation(reserved.id, paymentRecord.id, 'provider_error');
    throw new PaymentDeclinedError('Payment could not be processed', 'provider_error');
  }

  // ---- 3. Settle --------------------------------------------------------
  if (result.outcome === 'FAILED') {
    await releaseReservation(
      reserved.id,
      paymentRecord.id,
      result.failureCode ?? 'card_declined',
      result.raw,
    );
    throw new PaymentDeclinedError(
      result.failureMessage ?? 'Payment was declined',
      result.failureCode ?? 'card_declined',
    );
  }

  const order = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: paymentRecord.id },
      data: {
        status: result.outcome === 'CAPTURED' ? 'CAPTURED' : 'AUTHORIZED',
        providerRef: result.providerRef ?? null,
        rawResponse: asJson(result.raw),
      },
    });

    // The cart has done its job; retain it as CONVERTED for history. The
    // session token is deliberately left in place: it records which visit the
    // order came from, and `carts_owner_present` requires every cart to keep
    // an owner. A returning guest simply gets a fresh cart, because
    // `resolveCart` only ever matches ACTIVE ones.
    await tx.cartItem.deleteMany({ where: { cartId } });
    await tx.cart.update({
      where: { id: cartId },
      data: { status: 'CONVERTED' },
    });

    return tx.order.update({
      where: { id: reserved.id },
      data: { status: 'PAID' },
    });
  });

  logger.info(
    { orderId: order.id, orderNumber: order.orderNumber, totalCents: order.totalCents },
    'order placed',
  );

  return { order, itemCount: reserved.items.length };
}

/** Puts reserved stock back and cancels the order after a failed charge. */
async function releaseReservation(
  orderId: string,
  paymentId: string,
  failureCode: string,
  raw?: Record<string, unknown>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const items = await tx.orderItem.findMany({ where: { orderId } });

    for (const item of items) {
      if (!item.productId) continue;
      await tx.product.update({
        where: { id: item.productId },
        data: { stockQty: { increment: item.quantity } },
      });
    }

    await tx.payment.update({
      where: { id: paymentId },
      data: { status: 'FAILED', failureCode, rawResponse: raw ? asJson(raw) : undefined },
    });

    await tx.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  });

  logger.warn({ orderId, failureCode }, 'payment failed; stock released and order cancelled');
}
