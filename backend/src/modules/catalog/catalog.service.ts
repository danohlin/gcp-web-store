import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import type { ProductQuery } from './catalog.schemas.js';

export interface ProductSummary {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  stockQty: number;
  inStock: boolean;
  imageUrl: string | null;
  categories: { id: string; name: string; slug: string }[];
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Filtering, ranking and pagination all happen in one SQL statement so that
 * full-text relevance can participate in ORDER BY. It returns ids only; the
 * rows are then hydrated through Prisma to keep the result strongly typed.
 */
async function selectProductIds(
  query: ProductQuery,
): Promise<{ ids: string[]; total: number }> {
  const conditions: Prisma.Sql[] = [Prisma.sql`p.is_active = true`];

  // websearch_to_tsquery accepts human syntax ("red -shoes", quoted phrases)
  // and never throws on malformed input, unlike to_tsquery.
  const tsquery = query.q
    ? Prisma.sql`websearch_to_tsquery('english', ${query.q})`
    : undefined;

  if (tsquery) conditions.push(Prisma.sql`p.search_vector @@ ${tsquery}`);

  if (query.category) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM product_categories pc
      JOIN categories c ON c.id = pc.category_id
      WHERE pc.product_id = p.id AND c.slug = ${query.category}
    )`);
  }

  if (query.minPrice !== undefined) {
    conditions.push(Prisma.sql`p.price_cents >= ${query.minPrice}`);
  }
  if (query.maxPrice !== undefined) {
    conditions.push(Prisma.sql`p.price_cents <= ${query.maxPrice}`);
  }
  if (query.inStockOnly) {
    conditions.push(Prisma.sql`p.stock_qty > 0`);
  }

  // Relevance is only meaningful with a search term; fall back to newest.
  const sort = query.sort ?? (query.q ? 'relevance' : 'newest');
  const orderBy: Prisma.Sql = (() => {
    switch (sort) {
      case 'relevance':
        return tsquery
          ? Prisma.sql`ts_rank(p.search_vector, ${tsquery}) DESC, p.created_at DESC`
          : Prisma.sql`p.created_at DESC`;
      case 'price_asc':
        return Prisma.sql`p.price_cents ASC`;
      case 'price_desc':
        return Prisma.sql`p.price_cents DESC`;
      case 'name_asc':
        return Prisma.sql`p.name ASC`;
      case 'newest':
      default:
        return Prisma.sql`p.created_at DESC`;
    }
  })();

  const offset = (query.page - 1) * query.pageSize;

  const rows = await prisma.$queryRaw<{ id: string; total_count: bigint }[]>`
    SELECT p.id, COUNT(*) OVER() AS total_count
    FROM products p
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY ${orderBy}, p.id ASC
    LIMIT ${query.pageSize} OFFSET ${offset}
  `;

  return {
    ids: rows.map((r) => r.id),
    total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
  };
}

const summaryInclude = {
  images: { orderBy: { position: 'asc' }, take: 1 },
  categories: { include: { category: true } },
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof summaryInclude }>;

function toSummary(product: ProductWithRelations): ProductSummary {
  return {
    id: product.id,
    sku: product.sku,
    slug: product.slug,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    currency: product.currency,
    stockQty: product.stockQty,
    inStock: product.stockQty > 0,
    imageUrl: product.images[0]?.url ?? null,
    categories: product.categories.map((pc) => ({
      id: pc.category.id,
      name: pc.category.name,
      slug: pc.category.slug,
    })),
  };
}

export async function listProducts(query: ProductQuery): Promise<Paginated<ProductSummary>> {
  const { ids, total } = await selectProductIds(query);

  if (ids.length === 0) {
    return { items: [], page: query.page, pageSize: query.pageSize, total, totalPages: 0 };
  }

  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: summaryInclude,
  });

  // `IN (...)` does not preserve order, so restore the ranking from the id query.
  const byId = new Map(products.map((p) => [p.id, p]));
  const items = ids
    .map((id) => byId.get(id))
    .filter((p): p is ProductWithRelations => p !== undefined)
    .map(toSummary);

  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export interface ProductDetail extends ProductSummary {
  images: { id: string; url: string; alt: string; position: number }[];
  createdAt: Date;
}

export async function getProductBySlug(slug: string): Promise<ProductDetail> {
  const product = await prisma.product.findFirst({
    where: { slug, isActive: true },
    include: {
      images: { orderBy: { position: 'asc' } },
      categories: { include: { category: true } },
    },
  });

  if (!product) throw new NotFoundError('Product');

  return {
    ...toSummary(product as ProductWithRelations),
    images: product.images.map((i) => ({
      id: i.id,
      url: i.url,
      alt: i.alt,
      position: i.position,
    })),
    createdAt: product.createdAt,
  };
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  productCount: number;
  children: CategoryNode[];
}

/** Returns the category tree with counts of active products per category. */
export async function listCategories(): Promise<CategoryNode[]> {
  const categories = await prisma.category.findMany({
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    include: {
      _count: { select: { products: true } },
    },
  });

  const nodes = new Map<string, CategoryNode>();
  for (const c of categories) {
    nodes.set(c.id, {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      productCount: c._count.products,
      children: [],
    });
  }

  const roots: CategoryNode[] = [];
  for (const c of categories) {
    const node = nodes.get(c.id)!;
    const parent = c.parentId ? nodes.get(c.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}
