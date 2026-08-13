import { Link } from 'react-router-dom';
import { useCart } from '../store/CartContext';
import { formatMoney } from '../lib/format';
import { Alert, EmptyState, LoadingBlock, QuantityStepper } from '../components/ui';

export function CartPage() {
  const { cart, loading, error, updateItem, removeItem } = useCart();

  if (loading && !cart) return <LoadingBlock label="Loading your cart" />;

  if (!cart || cart.items.length === 0) {
    return (
      <EmptyState title="Your cart is empty">
        <p>
          <Link to="/">Browse the shop</Link> to add something.
        </p>
      </EmptyState>
    );
  }

  return (
    <div className="stack">
      <h1>Your cart</h1>

      {error && <Alert>{error}</Alert>}

      {cart.hasIssues && (
        <Alert variant="warning">
          Some items are no longer available in the quantity you selected. Adjust them to continue.
        </Alert>
      )}

      <div className="cart-layout">
        <ul className="cart-lines">
          {cart.items.map((line) => {
            const nameId = `line-${line.id}-name`;
            return (
              <li key={line.id} className="cart-line">
                <div className="cart-line__media">
                  {line.imageUrl && <img src={line.imageUrl} alt="" loading="lazy" />}
                </div>

                <div className="stack" style={{ minWidth: 0 }}>
                  <div>
                    <Link to={`/products/${line.slug}`} id={nameId}>
                      {line.name}
                    </Link>
                    <div className="muted" style={{ fontSize: '0.9rem' }}>
                      {formatMoney(line.unitPriceCents, cart.currency)} each
                    </div>
                  </div>

                  {line.exceedsStock && (
                    <p className="stock-note stock-note--out" style={{ margin: 0 }}>
                      {line.availableQty === 0
                        ? 'Out of stock'
                        : `Only ${line.availableQty} available`}
                    </p>
                  )}

                  <div className="row">
                    <QuantityStepper
                      value={line.quantity}
                      max={Math.max(line.availableQty, line.quantity)}
                      labelledBy={nameId}
                      onChange={(next) => void updateItem(line.id, next)}
                    />
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void removeItem(line.id)}
                    >
                      Remove
                      <span className="visually-hidden"> {line.name}</span>
                    </button>
                  </div>
                </div>

                <div className="cart-line__total">
                  {formatMoney(line.lineTotalCents, cart.currency)}
                </div>
              </li>
            );
          })}
        </ul>

        <aside className="panel summary" aria-label="Order summary">
          <h2>Summary</h2>

          <dl>
            <dt>Subtotal</dt>
            <dd>{formatMoney(cart.subtotalCents, cart.currency)}</dd>

            <dt>Shipping</dt>
            <dd>
              {cart.shippingCents === 0 ? 'Free' : formatMoney(cart.shippingCents, cart.currency)}
            </dd>

            <dt>Tax</dt>
            <dd>{formatMoney(cart.taxCents, cart.currency)}</dd>
          </dl>

          <div className="spread summary__total">
            <span>Total</span>
            <span>{formatMoney(cart.totalCents, cart.currency)}</span>
          </div>

          <p className="muted" style={{ fontSize: '0.88rem', marginTop: 'var(--space-3)' }}>
            Shipping is free on orders over {formatMoney(5000, cart.currency)}.
          </p>

          <Link
            to="/checkout"
            className="btn btn--block"
            aria-disabled={cart.hasIssues}
            onClick={(e) => {
              if (cart.hasIssues) e.preventDefault();
            }}
          >
            Checkout
          </Link>
        </aside>
      </div>
    </div>
  );
}
