/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import { hash, Algorithm } from '@node-rs/argon2';

/**
 * Idempotent seed. The ephemeral AWS environment is destroyed and recreated
 * daily, so this runs on every spin-up and must converge rather than duplicate.
 *
 * Seed account passwords come from the environment. The defaults below are
 * development-only; the Helm chart supplies real values from Secrets Manager.
 */
const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@web-store.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-123';
const CUSTOMER_EMAIL = process.env.SEED_CUSTOMER_EMAIL ?? 'customer@web-store.local';
const CUSTOMER_PASSWORD = process.env.SEED_CUSTOMER_PASSWORD ?? 'ChangeMe-Customer-123';

function hashPassword(plain: string): Promise<string> {
  return hash(plain, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

interface CategorySpec {
  slug: string;
  name: string;
  description: string;
  children?: CategorySpec[];
}

const CATEGORIES: CategorySpec[] = [
  {
    slug: 'electronics',
    name: 'Electronics',
    description: 'Audio, wearables and everyday tech.',
    children: [
      { slug: 'audio', name: 'Audio', description: 'Headphones, speakers and turntables.' },
      { slug: 'wearables', name: 'Wearables', description: 'Watches and fitness trackers.' },
    ],
  },
  {
    slug: 'home-kitchen',
    name: 'Home & Kitchen',
    description: 'Things that make the everyday better.',
    children: [
      { slug: 'coffee', name: 'Coffee', description: 'Grinders, kettles and brewers.' },
    ],
  },
  {
    slug: 'apparel',
    name: 'Apparel',
    description: 'Wardrobe staples in natural fibres.',
  },
];

interface ProductSpec {
  sku: string;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  stockQty: number;
  categories: string[];
  isActive?: boolean;
}

const PRODUCTS: ProductSpec[] = [
  {
    sku: 'WS-AUD-001',
    slug: 'aurora-over-ear-headphones',
    name: 'Aurora Over-Ear Headphones',
    description:
      'Closed-back wireless headphones with adaptive noise cancelling, 40 hour battery life and memory-foam earcups.',
    priceCents: 24999,
    stockQty: 42,
    categories: ['audio', 'electronics'],
  },
  {
    sku: 'WS-AUD-002',
    slug: 'pebble-bluetooth-speaker',
    name: 'Pebble Bluetooth Speaker',
    description:
      'Pocket-sized speaker with a surprisingly large sound, IPX7 waterproofing and 18 hours of playback.',
    priceCents: 7999,
    stockQty: 120,
    categories: ['audio', 'electronics'],
  },
  {
    sku: 'WS-AUD-003',
    slug: 'meridian-turntable',
    name: 'Meridian Belt-Drive Turntable',
    description:
      'Two-speed belt-drive turntable with a carbon fibre tonearm and a pre-installed moving magnet cartridge.',
    priceCents: 44900,
    stockQty: 7,
    categories: ['audio', 'electronics'],
  },
  {
    sku: 'WS-WEA-001',
    slug: 'summit-gps-watch',
    name: 'Summit GPS Watch',
    description:
      'Multi-band GPS, 21 day battery in smartwatch mode and a sapphire crystal face built for the outdoors.',
    priceCents: 39900,
    stockQty: 23,
    categories: ['wearables', 'electronics'],
  },
  {
    sku: 'WS-WEA-002',
    slug: 'pulse-fitness-band',
    name: 'Pulse Fitness Band',
    description:
      'Lightweight tracker with continuous heart rate, sleep staging and a seven day battery.',
    priceCents: 8999,
    stockQty: 200,
    categories: ['wearables', 'electronics'],
  },
  {
    sku: 'WS-COF-001',
    slug: 'burr-grinder-pro',
    name: 'Burr Grinder Pro',
    description:
      'Forty grind settings from espresso to French press, with a low-retention conical burr set.',
    priceCents: 17900,
    stockQty: 35,
    categories: ['coffee', 'home-kitchen'],
  },
  {
    sku: 'WS-COF-002',
    slug: 'gooseneck-kettle',
    name: 'Variable Temperature Gooseneck Kettle',
    description:
      'Precise pour control with one degree temperature settings and a hold function for long brews.',
    priceCents: 10900,
    stockQty: 64,
    categories: ['coffee', 'home-kitchen'],
  },
  {
    sku: 'WS-COF-003',
    slug: 'glass-pour-over-set',
    name: 'Glass Pour-Over Set',
    description: 'Borosilicate carafe and dripper with a reusable stainless steel filter.',
    priceCents: 4500,
    stockQty: 88,
    categories: ['coffee', 'home-kitchen'],
  },
  {
    sku: 'WS-HOM-001',
    slug: 'linen-throw-blanket',
    name: 'Stonewashed Linen Throw',
    description:
      'Heavyweight European linen, stonewashed for softness. Gets better with every wash.',
    priceCents: 12900,
    stockQty: 50,
    categories: ['home-kitchen'],
  },
  {
    sku: 'WS-APP-001',
    slug: 'merino-crew-sweater',
    name: 'Merino Crew Sweater',
    description: 'Mid-weight extra-fine merino with a clean crew neck. Breathable year round.',
    priceCents: 14900,
    stockQty: 75,
    categories: ['apparel'],
  },
  {
    sku: 'WS-APP-002',
    slug: 'oxford-shirt',
    name: 'Everyday Oxford Shirt',
    description: 'Garment-washed cotton oxford with a soft collar and a relaxed fit.',
    priceCents: 8900,
    stockQty: 110,
    categories: ['apparel'],
  },
  {
    sku: 'WS-APP-003',
    slug: 'waxed-canvas-tote',
    name: 'Waxed Canvas Tote',
    description: 'Water-resistant waxed cotton with leather handles and a roomy interior pocket.',
    priceCents: 11900,
    // Deliberately low so the low-stock UI state is visible.
    stockQty: 2,
    categories: ['apparel'],
  },
  {
    sku: 'WS-APP-004',
    slug: 'alpine-down-vest',
    name: 'Alpine Down Vest',
    description: 'Recycled ripstop shell with responsibly sourced 800-fill down.',
    priceCents: 19900,
    // Zero on purpose, so the out-of-stock path has something to render.
    stockQty: 0,
    categories: ['apparel'],
  },
];

function imageFor(slug: string, index: number): { url: string; alt: string; position: number } {
  return {
    // Deterministic placeholder imagery keyed by slug, so the catalogue looks
    // consistent across reseeds.
    url: `https://picsum.photos/seed/${slug}-${index}/800/800`,
    alt: '',
    position: index,
  };
}

async function seedCategories(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  async function upsert(spec: CategorySpec, parentId: string | null, position: number) {
    const category = await prisma.category.upsert({
      where: { slug: spec.slug },
      create: {
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        parentId,
        position,
      },
      update: { name: spec.name, description: spec.description, parentId, position },
    });

    ids.set(spec.slug, category.id);

    let childPosition = 0;
    for (const child of spec.children ?? []) {
      await upsert(child, category.id, childPosition++);
    }
  }

  let position = 0;
  for (const spec of CATEGORIES) {
    await upsert(spec, null, position++);
  }

  return ids;
}

async function seedProducts(categoryIds: Map<string, string>): Promise<void> {
  for (const spec of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { sku: spec.sku },
      create: {
        sku: spec.sku,
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        priceCents: spec.priceCents,
        stockQty: spec.stockQty,
        isActive: spec.isActive ?? true,
      },
      update: {
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        priceCents: spec.priceCents,
        stockQty: spec.stockQty,
        isActive: spec.isActive ?? true,
      },
    });

    // Replace rather than append, so reseeding does not accumulate rows.
    await prisma.productImage.deleteMany({ where: { productId: product.id } });
    await prisma.productImage.createMany({
      data: [0, 1].map((i) => ({ ...imageFor(spec.slug, i), productId: product.id })),
    });

    await prisma.productCategory.deleteMany({ where: { productId: product.id } });
    await prisma.productCategory.createMany({
      data: spec.categories
        .map((slug) => categoryIds.get(slug))
        .filter((id): id is string => Boolean(id))
        .map((categoryId) => ({ productId: product.id, categoryId })),
      skipDuplicates: true,
    });
  }
}

async function seedUsers(): Promise<void> {
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      firstName: 'Store',
      lastName: 'Admin',
      role: 'ADMIN',
    },
    // Password is reset on every seed so a rebuilt environment is predictable.
    update: { passwordHash: await hashPassword(ADMIN_PASSWORD), role: 'ADMIN' },
  });

  await prisma.user.upsert({
    where: { email: CUSTOMER_EMAIL },
    create: {
      email: CUSTOMER_EMAIL,
      passwordHash: await hashPassword(CUSTOMER_PASSWORD),
      firstName: 'Sam',
      lastName: 'Shopper',
      role: 'CUSTOMER',
    },
    update: { passwordHash: await hashPassword(CUSTOMER_PASSWORD) },
  });
}

async function main(): Promise<void> {
  console.log('Seeding categories...');
  const categoryIds = await seedCategories();

  console.log('Seeding products...');
  await seedProducts(categoryIds);

  console.log('Seeding users...');
  await seedUsers();

  const [categories, products, users] = await Promise.all([
    prisma.category.count(),
    prisma.product.count(),
    prisma.user.count(),
  ]);

  console.log(`Seed complete: ${categories} categories, ${products} products, ${users} users.`);
  console.log(`  admin:    ${ADMIN_EMAIL}`);
  console.log(`  customer: ${CUSTOMER_EMAIL}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
