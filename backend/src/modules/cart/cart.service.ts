import type { Cart } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { generateSessionToken } from '../../lib/tokens.js';
import { calculateTotals, type OrderTotals } from '../../lib/money.js';
import { InsufficientStockError, NotFoundError } from '../../lib/errors.js';

export interface CartLine {
  id: string;
  productId: string;
  slug: string;
  name: string;
  sku: string;
  imageUrl: string | null;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  /** Stock currently on hand, so the UI can cap the quantity selector. */
  availableQty: number;
  /** True when the line exceeds available stock and blocks checkout. */
  exceedsStock: boolean;
}

export interface CartView extends OrderTotals {
  id: string;
  currency: string;
  items: CartLine[];
  itemCount: number;
  /** Checkout is blocked while any line is unfulfillable. */
  hasIssues: boolean;
}

function guestExpiry(): Date {
  return new Date(Date.now() + config.guestCartTtlDays * 24 * 60 * 60 * 1000);
}

/**
 * Finds the caller's active cart, creating one when needed.
 *
 * A signed-in user is keyed by `userId`; a guest by an opaque `sessionToken`
 * held in an httpOnly cookie. When a new guest cart is created the caller is
 * responsible for writing the returned token back as a cookie.
 */
export async function resolveCart(opts: {
  userId?: string;
  sessionToken?: string;
}): Promise<{ cart: Cart; issuedSessionToken?: string }> {
  if (opts.userId) {
    const existing = await prisma.cart.findFirst({
      where: { userId: opts.userId, status: 'ACTIVE' },
    });
    if (existing) return { cart: existing };

    return {
      cart: await prisma.cart.create({ data: { userId: opts.userId, status: 'ACTIVE' } }),
    };
  }

  if (opts.sessionToken) {
    const existing = await prisma.cart.findFirst({
      where: { sessionToken: opts.sessionToken, status: 'ACTIVE' },
    });
    if (existing) {
      // Touch the expiry so an actively used guest cart does not lapse.
      if (existing.expiresAt && existing.expiresAt < guestExpiry()) {
        await prisma.cart.update({ where: { id: existing.id }, data: { expiresAt: guestExpiry() } });
      }
      return { cart: existing };
    }
  }

  const sessionToken = generateSessionToken();
  const cart = await prisma.cart.create({
    data: { sessionToken, status: 'ACTIVE', expiresAt: guestExpiry() },
  });
  return { cart, issuedSessionToken: sessionToken };
}

export async function getCartView(cartId: string): Promise<CartView> {
  const cart = await prisma.cart.findUnique({
    where: { id: cartId },
    include: {
      items: {
        orderBy: { createdAt: 'asc' },
        include: { product: { include: { images: { orderBy: { position: 'asc' }, take: 1 } } } },
      },
    },
  });

  if (!cart) throw new NotFoundError('Cart');

  const items: CartLine[] = cart.items.map((item) => ({
    id: item.id,
    productId: item.productId,
    slug: item.product.slug,
    name: item.product.name,
    sku: item.product.sku,
    imageUrl: item.product.images[0]?.url ?? null,
    // Priced live from the product, never from a stored snapshot.
    unitPriceCents: item.product.priceCents,
    quantity: item.quantity,
    lineTotalCents: item.product.priceCents * item.quantity,
    availableQty: item.product.stockQty,
    exceedsStock: !item.product.isActive || item.quantity > item.product.stockQty,
  }));

  const totals = calculateTotals(
    items.map((i) => ({ unitPriceCents: i.unitPriceCents, quantity: i.quantity })),
  );

  return {
    id: cart.id,
    currency: cart.items[0]?.product.currency ?? 'USD',
    items,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    hasIssues: items.some((i) => i.exceedsStock),
    ...totals,
  };
}

export async function addItem(cartId: string, productId: string, quantity: number): Promise<void> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) throw new NotFoundError('Product');

  const existing = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId, productId } },
  });

  // Adding to an existing line accumulates rather than replaces.
  const desired = (existing?.quantity ?? 0) + quantity;
  if (desired > product.stockQty) {
    throw new InsufficientStockError(product.name, product.stockQty);
  }

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId, productId } },
    create: { cartId, productId, quantity },
    update: { quantity: desired },
  });
}

export async function updateItem(cartId: string, itemId: string, quantity: number): Promise<void> {
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cartId },
    include: { product: true },
  });
  if (!item) throw new NotFoundError('Cart item');

  if (quantity <= 0) {
    await prisma.cartItem.delete({ where: { id: item.id } });
    return;
  }

  if (quantity > item.product.stockQty) {
    throw new InsufficientStockError(item.product.name, item.product.stockQty);
  }

  await prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
}

export async function removeItem(cartId: string, itemId: string): Promise<void> {
  const { count } = await prisma.cartItem.deleteMany({ where: { id: itemId, cartId } });
  if (count === 0) throw new NotFoundError('Cart item');
}

export async function clearCart(cartId: string): Promise<void> {
  await prisma.cartItem.deleteMany({ where: { cartId } });
}

/**
 * Folds a guest cart into the user's cart at sign-in.
 *
 * Quantities are summed and then capped at available stock, so merging can
 * never produce an unfulfillable line. The guest cart is marked CONVERTED
 * rather than deleted, which keeps the audit trail and releases its
 * session token.
 */
export async function mergeGuestCart(sessionToken: string, userId: string): Promise<void> {
  const guestCart = await prisma.cart.findFirst({
    where: { sessionToken, status: 'ACTIVE' },
    include: { items: { include: { product: true } } },
  });

  if (!guestCart) return;

  const { cart: userCart } = await resolveCart({ userId });

  if (guestCart.id === userCart.id) return;

  await prisma.$transaction(async (tx) => {
    for (const item of guestCart.items) {
      if (!item.product.isActive || item.product.stockQty <= 0) continue;

      const existing = await tx.cartItem.findUnique({
        where: { cartId_productId: { cartId: userCart.id, productId: item.productId } },
      });

      const merged = Math.min((existing?.quantity ?? 0) + item.quantity, item.product.stockQty);

      await tx.cartItem.upsert({
        where: { cartId_productId: { cartId: userCart.id, productId: item.productId } },
        create: { cartId: userCart.id, productId: item.productId, quantity: merged },
        update: { quantity: merged },
      });
    }

    await tx.cart.update({
      where: { id: guestCart.id },
      // The session token stays attached: `carts_owner_present` requires every
      // cart to retain an owner, and a stale cookie is harmless because
      // `resolveCart` only matches ACTIVE carts.
      data: { status: 'CONVERTED' },
    });
  });

  logger.info(
    { userId, guestCartId: guestCart.id, userCartId: userCart.id, lines: guestCart.items.length },
    'guest cart merged',
  );
}
