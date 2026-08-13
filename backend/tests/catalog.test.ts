import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, createCategory, createProduct } from './helpers.js';
import { prisma } from '../src/lib/prisma.js';

describe('GET /api/products', () => {
  it('lists only active products', async () => {
    await createProduct({ name: 'Visible', isActive: true });
    await createProduct({ name: 'Retired', isActive: false });

    const res = await request(app).get('/api/products').expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Visible');
    expect(res.body.total).toBe(1);
  });

  it('paginates and reports totals', async () => {
    for (let i = 0; i < 5; i++) await createProduct({ name: `Product ${i}` });

    const res = await request(app).get('/api/products?page=2&pageSize=2').expect(200);

    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.totalPages).toBe(3);
    expect(res.body.page).toBe(2);
  });

  it('filters by category slug', async () => {
    const audio = await createCategory('audio', 'Audio');
    await createProduct({ name: 'Headphones', categoryIds: [audio.id] });
    await createProduct({ name: 'Sweater' });

    const res = await request(app).get('/api/products?category=audio').expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Headphones');
  });

  it('filters by price range', async () => {
    await createProduct({ name: 'Cheap', priceCents: 500 });
    await createProduct({ name: 'Mid', priceCents: 5000 });
    await createProduct({ name: 'Pricey', priceCents: 50000 });

    const res = await request(app).get('/api/products?minPrice=1000&maxPrice=10000').expect(200);

    expect(res.body.items.map((p: { name: string }) => p.name)).toEqual(['Mid']);
  });

  it('sorts by price', async () => {
    await createProduct({ name: 'B', priceCents: 2000 });
    await createProduct({ name: 'A', priceCents: 1000 });
    await createProduct({ name: 'C', priceCents: 3000 });

    const asc = await request(app).get('/api/products?sort=price_asc').expect(200);
    expect(asc.body.items.map((p: { priceCents: number }) => p.priceCents)).toEqual([
      1000, 2000, 3000,
    ]);

    const desc = await request(app).get('/api/products?sort=price_desc').expect(200);
    expect(desc.body.items.map((p: { priceCents: number }) => p.priceCents)).toEqual([
      3000, 2000, 1000,
    ]);
  });

  it('can exclude out-of-stock products', async () => {
    await createProduct({ name: 'In stock', stockQty: 5 });
    await createProduct({ name: 'Sold out', stockQty: 0 });

    const all = await request(app).get('/api/products').expect(200);
    expect(all.body.items).toHaveLength(2);

    const inStock = await request(app).get('/api/products?inStockOnly=true').expect(200);
    expect(inStock.body.items).toHaveLength(1);
    expect(inStock.body.items[0].name).toBe('In stock');
  });
});

describe('full-text search', () => {
  it('matches on name and description', async () => {
    await createProduct({
      name: 'Aurora Over-Ear Headphones',
      description: 'Wireless noise cancelling headphones',
    });
    await createProduct({ name: 'Merino Sweater', description: 'Soft wool knitwear' });

    const res = await request(app).get('/api/products?q=headphones').expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Aurora Over-Ear Headphones');
  });

  it('stems search terms', async () => {
    await createProduct({ name: 'Running Shoe', description: 'For runners' });

    // "running" and "runner" share a stem, so either term finds the product.
    const res = await request(app).get('/api/products?q=runner').expect(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('ranks a name match above a description-only match', async () => {
    await createProduct({
      name: 'Generic Storage Box',
      description: 'Holds a turntable and other equipment',
    });
    await createProduct({ name: 'Meridian Turntable', description: 'Belt drive' });

    const res = await request(app).get('/api/products?q=turntable').expect(200);

    expect(res.body.items).toHaveLength(2);
    // The name carries weight A, the description weight C.
    expect(res.body.items[0].name).toBe('Meridian Turntable');
  });

  it('supports negation via websearch syntax', async () => {
    await createProduct({ name: 'Wireless Headphones', description: 'bluetooth' });
    await createProduct({ name: 'Wired Headphones', description: 'cable' });

    const res = await request(app).get('/api/products?q=headphones -bluetooth').expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Wired Headphones');
  });

  it('matches on category name even when the product text never says it', async () => {
    const coffee = await createCategory('coffee', 'Coffee');
    await createProduct({
      name: 'Burr Grinder Pro',
      description: 'Forty grind settings from espresso to French press',
      categoryIds: [coffee.id],
    });
    await createProduct({ name: 'Merino Sweater', description: 'Soft wool knitwear' });

    const res = await request(app).get('/api/products?q=coffee').expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Burr Grinder Pro');
  });

  it('re-indexes when a product is moved out of a category', async () => {
    const coffee = await createCategory('coffee', 'Coffee');
    const product = await createProduct({ name: 'Burr Grinder Pro', categoryIds: [coffee.id] });

    await request(app).get('/api/products?q=coffee').expect(200).expect((res) => {
      expect(res.body.items).toHaveLength(1);
    });

    // The product row itself is untouched here, so only a trigger on the join
    // table can keep the vector correct.
    await prisma.productCategory.deleteMany({ where: { productId: product.id } });

    const after = await request(app).get('/api/products?q=coffee').expect(200);
    expect(after.body.items).toHaveLength(0);
  });

  it('re-indexes every product when a category is renamed', async () => {
    const category = await createCategory('hot-drinks', 'Hot Drinks');
    await createProduct({ name: 'Burr Grinder Pro', categoryIds: [category.id] });

    await prisma.category.update({ where: { id: category.id }, data: { name: 'Coffee' } });

    const found = await request(app).get('/api/products?q=coffee').expect(200);
    expect(found.body.items).toHaveLength(1);

    const gone = await request(app).get('/api/products?q=%22hot%20drinks%22').expect(200);
    expect(gone.body.items).toHaveLength(0);
  });

  it('ranks a name match above a category-only match', async () => {
    const coffee = await createCategory('coffee', 'Coffee');
    await createProduct({ name: 'Burr Grinder Pro', categoryIds: [coffee.id] });
    await createProduct({ name: 'Coffee Table Book', description: 'Photography' });

    const res = await request(app).get('/api/products?q=coffee').expect(200);

    expect(res.body.items).toHaveLength(2);
    // Name carries weight A, category weight B.
    expect(res.body.items[0].name).toBe('Coffee Table Book');
  });

  it('returns an empty page rather than an error for gibberish', async () => {
    await createProduct({ name: 'Anything' });

    const res = await request(app).get('/api/products?q=%22%22%3A%3A%21').expect(200);

    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /api/products/:slug', () => {
  it('returns product detail with images', async () => {
    const product = await createProduct({ slug: 'meridian-turntable', name: 'Meridian Turntable' });

    const res = await request(app).get(`/api/products/${product.slug}`).expect(200);

    expect(res.body.name).toBe('Meridian Turntable');
    expect(res.body.images).toEqual([]);
    expect(res.body.inStock).toBe(true);
  });

  it('404s for an unknown or inactive product', async () => {
    await createProduct({ slug: 'retired-item', isActive: false });

    await request(app).get('/api/products/does-not-exist').expect(404);
    await request(app).get('/api/products/retired-item').expect(404);
  });

  it('rejects a malformed slug', async () => {
    await request(app).get('/api/products/Not%20A%20Slug').expect(422);
  });
});

describe('GET /api/categories', () => {
  it('returns the category tree with product counts', async () => {
    const electronics = await createCategory('electronics', 'Electronics');
    const { prisma } = await import('../src/lib/prisma.js');
    const audio = await prisma.category.create({
      data: { slug: 'audio', name: 'Audio', parentId: electronics.id },
    });
    await createProduct({ categoryIds: [audio.id] });

    const res = await request(app).get('/api/categories').expect(200);

    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0].slug).toBe('electronics');
    expect(res.body.categories[0].children).toHaveLength(1);
    expect(res.body.categories[0].children[0].productCount).toBe(1);
  });
});
