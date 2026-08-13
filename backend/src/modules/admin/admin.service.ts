import type { Prisma } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import type { Paginated } from '../catalog/catalog.service.js';
import {
  slugify,
  type AdminOrderQuery,
  type AdminProductQuery,
  type CreateCategoryInput,
  type CreateProductInput,
  type UpdateCategoryInput,
  type UpdateProductInput,
} from './admin.schemas.js';

const adminProductInclude = {
  images: { orderBy: { position: 'asc' } },
  categories: { include: { category: true } },
} satisfies Prisma.ProductInclude;

// ------------------------------------------------------------------ products

export async function listProducts(query: AdminProductQuery) {
  const where: Prisma.ProductWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { sku: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: adminProductInclude,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function getProduct(id: string) {
  const product = await prisma.product.findUnique({ where: { id }, include: adminProductInclude });
  if (!product) throw new NotFoundError('Product');
  return product;
}

export async function createProduct(input: CreateProductInput) {
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw new BadRequestError('Could not derive a slug from that name; supply one');

  await assertCategoriesExist(input.categoryIds);

  const product = await prisma.product.create({
    data: {
      sku: input.sku,
      slug,
      name: input.name,
      description: input.description,
      priceCents: input.priceCents,
      currency: input.currency,
      stockQty: input.stockQty,
      isActive: input.isActive,
      images: { create: input.images },
      categories: { create: input.categoryIds.map((categoryId) => ({ categoryId })) },
    },
    include: adminProductInclude,
  });

  logger.info({ productId: product.id, sku: product.sku }, 'product created');
  return product;
}

export async function updateProduct(id: string, input: UpdateProductInput) {
  await getProduct(id);

  if (input.categoryIds) await assertCategoriesExist(input.categoryIds);

  const product = await prisma.$transaction(async (tx) => {
    // Images and categories are replaced wholesale when supplied — simpler and
    // more predictable than diffing from an admin form.
    if (input.images) {
      await tx.productImage.deleteMany({ where: { productId: id } });
      if (input.images.length > 0) {
        await tx.productImage.createMany({
          data: input.images.map((img) => ({ ...img, productId: id })),
        });
      }
    }

    if (input.categoryIds) {
      await tx.productCategory.deleteMany({ where: { productId: id } });
      if (input.categoryIds.length > 0) {
        await tx.productCategory.createMany({
          data: input.categoryIds.map((categoryId) => ({ productId: id, categoryId })),
        });
      }
    }

    return tx.product.update({
      where: { id },
      data: {
        sku: input.sku,
        slug: input.slug,
        name: input.name,
        description: input.description,
        priceCents: input.priceCents,
        currency: input.currency,
        stockQty: input.stockQty,
        isActive: input.isActive,
      },
      include: adminProductInclude,
    });
  });

  logger.info({ productId: id }, 'product updated');
  return product;
}

/**
 * Soft delete. Hard-deleting would strip the product reference from historical
 * order lines, so products are retired instead and disappear from the catalog.
 */
export async function deleteProduct(id: string) {
  await getProduct(id);

  const product = await prisma.$transaction(async (tx) => {
    // Drop it from any live cart so nobody checks out a retired product.
    await tx.cartItem.deleteMany({ where: { productId: id } });
    return tx.product.update({
      where: { id },
      data: { isActive: false },
      include: adminProductInclude,
    });
  });

  logger.info({ productId: id }, 'product retired');
  return product;
}

async function assertCategoriesExist(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await prisma.category.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw new BadRequestError('One or more categories do not exist');
}

// ---------------------------------------------------------------- categories

export async function createCategory(input: CreateCategoryInput) {
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw new BadRequestError('Could not derive a slug from that name; supply one');

  if (input.parentId) {
    const parent = await prisma.category.findUnique({ where: { id: input.parentId } });
    if (!parent) throw new BadRequestError('Parent category does not exist');
  }

  return prisma.category.create({
    data: {
      name: input.name,
      slug,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      position: input.position,
    },
  });
}

export async function updateCategory(id: string, input: UpdateCategoryInput) {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Category');

  if (input.parentId) {
    if (input.parentId === id) throw new BadRequestError('A category cannot be its own parent');
    const parent = await prisma.category.findUnique({ where: { id: input.parentId } });
    if (!parent) throw new BadRequestError('Parent category does not exist');
    if (await createsCycle(id, input.parentId)) {
      throw new BadRequestError('That parent would create a cycle in the category tree');
    }
  }

  return prisma.category.update({
    where: { id },
    data: {
      name: input.name,
      slug: input.slug,
      description: input.description,
      parentId: input.parentId,
      position: input.position,
    },
  });
}

/** Walks up from the proposed parent looking for the category being edited. */
async function createsCycle(categoryId: string, proposedParentId: string): Promise<boolean> {
  let cursor: string | null = proposedParentId;
  const seen = new Set<string>();

  while (cursor) {
    if (cursor === categoryId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);

    const parent: { parentId: string | null } | null = await prisma.category.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    cursor = parent?.parentId ?? null;
  }

  return false;
}

export async function deleteCategory(id: string) {
  const category = await prisma.category.findUnique({
    where: { id },
    include: { _count: { select: { products: true, children: true } } },
  });
  if (!category) throw new NotFoundError('Category');

  if (category._count.children > 0) {
    throw new ConflictError('Move or remove the subcategories first', 'CATEGORY_HAS_CHILDREN');
  }

  // Product links cascade; the products themselves are untouched.
  await prisma.category.delete({ where: { id } });
  return { id };
}

// -------------------------------------------------------------------- orders

/**
 * Permitted status moves. Terminal states have no outgoing transitions, which
 * stops an accidental click from reviving a cancelled order.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: [OrderStatus.PAID, OrderStatus.CANCELLED],
  PAID: [OrderStatus.PROCESSING, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
  PROCESSING: [OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
  SHIPPED: [OrderStatus.DELIVERED, OrderStatus.REFUNDED],
  DELIVERED: [OrderStatus.REFUNDED],
  CANCELLED: [],
  REFUNDED: [],
};

export async function listOrders(query: AdminOrderQuery): Promise<Paginated<unknown>> {
  const where: Prisma.OrderWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.email ? { email: { contains: query.email, mode: 'insensitive' } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: true, payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { placedAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function updateOrderStatus(id: string, status: OrderStatus) {
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!order) throw new NotFoundError('Order');

  if (order.status === status) return order;

  if (!ALLOWED_TRANSITIONS[order.status].includes(status)) {
    throw new ConflictError(
      `Cannot move an order from ${order.status} to ${status}`,
      'INVALID_STATUS_TRANSITION',
      { from: order.status, to: status, allowed: ALLOWED_TRANSITIONS[order.status] },
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Cancelling or refunding returns the reserved units to sellable stock.
    if (status === OrderStatus.CANCELLED || status === OrderStatus.REFUNDED) {
      for (const item of order.items) {
        if (!item.productId) continue;
        await tx.product.update({
          where: { id: item.productId },
          data: { stockQty: { increment: item.quantity } },
        });
      }
    }

    return tx.order.update({
      where: { id },
      data: {
        status,
        ...(status === OrderStatus.CANCELLED ? { cancelledAt: new Date() } : {}),
      },
      include: { items: true, payments: true },
    });
  });

  logger.info({ orderId: id, from: order.status, to: status }, 'order status updated');
  return updated;
}
