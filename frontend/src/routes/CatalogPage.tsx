import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { catalog } from '../api/endpoints';
import type { CategoryNode, ProductSummary } from '../api/types';
import { useAsync, useDebounced } from '../lib/useAsync';
import { formatMoney } from '../lib/format';
import { useCart } from '../store/CartContext';
import { Alert, EmptyState, LoadingBlock, Pagination, SelectField } from '../components/ui';

function CategoryTree({
  nodes,
  active,
  onSelect,
}: {
  nodes: CategoryNode[];
  active: string | null;
  onSelect: (slug: string | null) => void;
}) {
  return (
    <ul className="category-list">
      {nodes.map((node) => (
        <li key={node.id}>
          <a
            href={`?category=${node.slug}`}
            aria-current={active === node.slug ? 'true' : undefined}
            onClick={(e) => {
              e.preventDefault();
              onSelect(active === node.slug ? null : node.slug);
            }}
          >
            {node.name} <span className="muted">({node.productCount})</span>
          </a>
          {node.children.length > 0 && (
            <CategoryTree nodes={node.children} active={active} onSelect={onSelect} />
          )}
        </li>
      ))}
    </ul>
  );
}

function ProductCard({ product }: { product: ProductSummary }) {
  const { addItem } = useCart();
  const [adding, setAdding] = useState(false);
  const titleId = `product-${product.id}-title`;

  async function handleAdd() {
    setAdding(true);
    try {
      await addItem(product.id, 1);
    } catch {
      // The cart store surfaces the message; nothing to do here.
    } finally {
      setAdding(false);
    }
  }

  return (
    <li className="product-card">
      <Link to={`/products/${product.slug}`} className="product-card__media" tabIndex={-1} aria-hidden="true">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt="" loading="lazy" />
        ) : (
          <div style={{ width: '100%', height: '100%' }} />
        )}
      </Link>

      <div className="product-card__body">
        <h3 className="product-card__title" id={titleId}>
          <Link to={`/products/${product.slug}`}>{product.name}</Link>
        </h3>

        <span className="product-card__price">
          {formatMoney(product.priceCents, product.currency)}
        </span>

        {!product.inStock ? (
          <span className="stock-note stock-note--out">Out of stock</span>
        ) : product.stockQty <= 3 ? (
          <span className="stock-note stock-note--low">Only {product.stockQty} left</span>
        ) : null}

        <div className="product-card__footer">
          <button
            type="button"
            className="btn btn--block"
            onClick={() => void handleAdd()}
            disabled={!product.inStock || adding}
            aria-describedby={titleId}
          >
            {adding ? 'Adding…' : product.inStock ? 'Add to cart' : 'Out of stock'}
          </button>
        </div>
      </div>
    </li>
  );
}

export function CatalogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParams.get('q') ?? '');
  const debouncedSearch = useDebounced(searchInput, 300);
  const { error: cartError, clearError } = useCart();

  const category = searchParams.get('category');
  const sort = searchParams.get('sort') ?? '';
  const page = Number(searchParams.get('page') ?? '1');

  // Keep the URL in step with the debounced search box so results are
  // shareable and the back button behaves.
  useEffect(() => {
    const current = searchParams.get('q') ?? '';
    if (current === debouncedSearch) return;

    const next = new URLSearchParams(searchParams);
    if (debouncedSearch) next.set('q', debouncedSearch);
    else next.delete('q');
    next.delete('page');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== 'page') next.delete('page');
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const categories = useAsync(() => catalog.categories(), []);

  const products = useAsync(
    () =>
      catalog.products({
        q: debouncedSearch || undefined,
        category: category ?? undefined,
        sort: (sort || undefined) as never,
        page,
        pageSize: 12,
      }),
    [debouncedSearch, category, sort, page],
  );

  return (
    <div className="stack">
      <h1>Shop</h1>

      {cartError && (
        <Alert>
          <span className="spread">
            {cartError}
            <button type="button" className="btn btn--ghost" onClick={clearError}>
              Dismiss
            </button>
          </span>
        </Alert>
      )}

      <div className="catalog">
        <aside className="filters" aria-label="Filters">
          <div>
            <h2>Categories</h2>
            {categories.data ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => updateParam('category', null)}
                  disabled={!category}
                >
                  All products
                </button>
                <CategoryTree
                  nodes={categories.data.categories}
                  active={category}
                  onSelect={(slug) => updateParam('category', slug)}
                />
              </>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </div>
        </aside>

        <section aria-label="Products">
          <div className="toolbar">
            <div className="field toolbar__search">
              <label htmlFor="search">Search products</label>
              <input
                id="search"
                type="search"
                value={searchInput}
                placeholder="Try “headphones” or “coffee”"
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>

            <SelectField
              label="Sort by"
              value={sort}
              onChange={(e) => updateParam('sort', e.target.value || null)}
            >
              <option value="">{debouncedSearch ? 'Most relevant' : 'Newest'}</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="name_asc">Name: A to Z</option>
            </SelectField>
          </div>

          {products.loading && !products.data ? (
            <LoadingBlock label="Loading products" />
          ) : products.error ? (
            <Alert>{products.error}</Alert>
          ) : !products.data || products.data.items.length === 0 ? (
            <EmptyState title="No products found">
              <p>Try a different search or clear your filters.</p>
            </EmptyState>
          ) : (
            <>
              <p className="muted" aria-live="polite">
                {products.data.total} {products.data.total === 1 ? 'product' : 'products'}
              </p>

              <ul className="product-grid">
                {products.data.items.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </ul>

              <Pagination
                page={products.data.page}
                totalPages={products.data.totalPages}
                onChange={(next) => updateParam('page', String(next))}
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
