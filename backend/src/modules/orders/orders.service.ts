import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { Paginated } from '../catalog/catalog.service.js';

const detailInclude = {
  items: { orderBy: { productName: 'asc' } },
  payments: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof detailInclude }>;

export interface OrderLine {
  id: string;
  productId: string | null;
  productName: string;
  sku: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface OrderDetail {
  id: string;
  orderNumber: string;
  status: string;
  email: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  shippingAddress: unknown;
  billingAddress: unknown;
  placedAt: Date;
  items: OrderLine[];
  payment: {
    status: string;
    provider: string;
    reference: string | null;
    failureCode: string | null;
  } | null;
}

export function toOrderDetail(order: OrderWithRelations): OrderDetail {
  const payment = order.payments[0];
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    email: order.email,
    subtotalCents: order.subtotalCents,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    currency: order.currency,
    shippingAddress: order.shippingAddress,
    billingAddress: order.billingAddress,
    placedAt: order.placedAt,
    items: order.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productName: i.productName,
      sku: i.sku,
      unitPriceCents: i.unitPriceCents,
      quantity: i.quantity,
      lineTotalCents: i.lineTotalCents,
    })),
    // Card details are never stored, so only the outcome is exposed.
    payment: payment
      ? {
          status: payment.status,
          provider: payment.provider,
          reference: payment.providerRef,
          failureCode: payment.failureCode,
        }
      : null,
  };
}

export async function getById(orderId: string): Promise<OrderDetail> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: detailInclude });
  if (!order) throw new NotFoundError('Order');
  return toOrderDetail(order);
}

export async function listForUser(
  userId: string,
  opts: { page: number; pageSize: number },
): Promise<Paginated<OrderDetail>> {
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      include: detailInclude,
      orderBy: { placedAt: 'desc' },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    }),
    prisma.order.count({ where: { userId } }),
  ]);

  return {
    items: orders.map(toOrderDetail),
    page: opts.page,
    pageSize: opts.pageSize,
    total,
    totalPages: Math.ceil(total / opts.pageSize),
  };
}

export async function getForUser(
  orderNumber: string,
  user: { id: string; role: string },
): Promise<OrderDetail> {
  const order = await prisma.order.findUnique({ where: { orderNumber }, include: detailInclude });
  if (!order) throw new NotFoundError('Order');

  if (order.userId !== user.id && user.role !== 'ADMIN') {
    // 403 rather than 404: the order number was valid, the caller just does not
    // own it. Order numbers are not secret enough to leak by existence alone.
    throw new ForbiddenError('This order belongs to another account');
  }

  return toOrderDetail(order);
}
