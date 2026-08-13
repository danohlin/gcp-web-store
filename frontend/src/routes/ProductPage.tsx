import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { catalog } from '../api/endpoints';
import { useAsync } from '../lib/useAsync';
import { formatMoney } from '../lib/format';
import { useCart } from '../store/CartContext';
import { Alert, EmptyState, LoadingBlock, QuantityStepper } from '../components/ui';

export function ProductPage() {
  const { slug = '' } = useParams();
  const { addItem, error: cartError, clearError } = useCart();

  const [quantity, setQuantity] = useState(1);
  const [activeImage, setActiveImage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const { data: product, loading, error } = useAsync(() => catalog.product(slug), [slug]);

  if (loading && !product) return <LoadingBlock label="Loading product" />;
  if (error || !product) {
    return (
      <EmptyState title="Product not found">
        <p>
          It may have been removed. <Link to="/">Back to the shop</Link>.
        </p>
      </EmptyState>
    );
  }

  const images = product.images.length > 0 ? product.images : null;
  const hero = images?.[activeImage] ?? null;

  async function handleAdd() {
    if (!product) return;
    clearError();
    setAdding(true);
    setAdded(false);
    try {
      await addItem(product.id, quantity);
      setAdded(true);
    } catch {
      // Message is surfaced from the cart store below.
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="stack">
      <nav aria-label="Breadcrumb">
        <Link to="/">← Back to shop</Link>
      </nav>

      <div className="product-detail">
        <div>
          <div className="gallery__main">
            {hero ? <img src={hero.url} alt={hero.alt || product.name} /> : null}
          </div>

          {images && images.length > 1 && (
            <ul className="gallery__thumbs">
              {images.map((image, index) => (
                <li key={image.id}>
                  <button
                    type="button"
                    aria-pressed={index === activeImage}
                    aria-label={`Show image ${index + 1} of ${images.length}`}
                    onClick={() => setActiveImage(index)}
                  >
                    <img src={image.url} alt="" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="stack">
          <h1>{product.name}</h1>

          <p className="price-large">{formatMoney(product.priceCents, product.currency)}</p>

          <p>{product.description}</p>

          <p className="muted">
            SKU {product.sku}
            {product.categories.length > 0 && (
              <>
                {' · '}
                {product.categories.map((category, index) => (
                  <span key={category.id}>
                    {index > 0 && ', '}
                    <Link to={`/?category=${category.slug}`}>{category.name}</Link>
                  </span>
                ))}
              </>
            )}
          </p>

          {product.inStock ? (
            product.stockQty <= 3 && (
              <p className="stock-note stock-note--low">Only {product.stockQty} left in stock</p>
            )
          ) : (
            <p className="stock-note stock-note--out">Out of stock</p>
          )}

          {cartError && <Alert>{cartError}</Alert>}

          {added && !cartError && (
            <Alert variant="success">
              Added to your cart. <Link to="/cart">View cart</Link>
            </Alert>
          )}

          {product.inStock && (
            <div className="row">
              <span id="qty-label" className="visually-hidden">
                Quantity
              </span>
              <QuantityStepper
                value={quantity}
                max={Math.min(product.stockQty, 99)}
                onChange={(next) => setQuantity(Math.max(1, next))}
                labelledBy="qty-label"
                disabled={adding}
              />
              <button type="button" className="btn" onClick={() => void handleAdd()} disabled={adding}>
                {adding ? 'Adding…' : 'Add to cart'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
