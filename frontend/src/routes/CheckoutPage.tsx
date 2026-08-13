import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { checkout } from '../api/endpoints';
import { ApiError } from '../api/client';
import type { Address, PaymentDetails } from '../api/types';
import { useCart } from '../store/CartContext';
import { useAuth } from '../store/AuthContext';
import { formatMoney } from '../lib/format';
import { Alert, EmptyState, Field, LoadingBlock, SelectField } from '../components/ui';

const EMPTY_ADDRESS: Address = {
  fullName: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'US',
};

const EMPTY_PAYMENT: PaymentDetails = {
  cardNumber: '',
  expMonth: 0,
  expYear: 0,
  cvc: '',
  nameOnCard: '',
};

export function CheckoutPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { cart, loading, reload } = useCart();

  const [email, setEmail] = useState('');
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [payment, setPayment] = useState<PaymentDetails>(EMPTY_PAYMENT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (loading && !cart) return <LoadingBlock label="Loading checkout" />;

  if (!cart || cart.items.length === 0) {
    return (
      <EmptyState title="Nothing to check out">
        <p>
          Your cart is empty. <Link to="/">Browse the shop</Link>.
        </p>
      </EmptyState>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      const { order } = await checkout.placeOrder({
        ...(user ? {} : { email }),
        shippingAddress: address,
        payment: {
          ...payment,
          expMonth: Number(payment.expMonth),
          expYear: Number(payment.expYear),
        },
      });

      await reload();
      // Replace so the back button does not resubmit the order.
      navigate(`/orders/confirmation/${order.orderNumber}`, { replace: true, state: { order } });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
        // A stock conflict means the cart view is stale.
        if (err.code === 'INSUFFICIENT_STOCK') await reload();
      } else {
        setError('Something went wrong. Please try again.');
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSubmitting(false);
    }
  }

  const set =
    <T,>(setter: React.Dispatch<React.SetStateAction<T>>, key: keyof T) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setter((prev) => ({ ...prev, [key]: e.target.value }));

  const currentYear = new Date().getFullYear();

  return (
    <div className="stack">
      <h1>Checkout</h1>

      {error && <Alert>{error}</Alert>}

      <div className="checkout-layout">
        <form onSubmit={(e) => void handleSubmit(e)} noValidate>
          {!user && (
            <fieldset className="fieldset">
              <legend>Contact</legend>
              <Field
                label="Email address"
                type="email"
                autoComplete="email"
                required
                value={email}
                error={fieldErrors.email}
                hint="Your order confirmation goes here."
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="muted" style={{ marginTop: 'var(--space-3)' }}>
                Have an account? <Link to="/login">Sign in</Link> to save this order to your history.
              </p>
            </fieldset>
          )}

          <fieldset className="fieldset">
            <legend>Shipping address</legend>
            <div className="stack">
              <Field
                label="Full name"
                autoComplete="name"
                required
                value={address.fullName}
                error={fieldErrors['shippingAddress.fullName']}
                onChange={set(setAddress, 'fullName')}
              />
              <Field
                label="Address line 1"
                autoComplete="address-line1"
                required
                value={address.line1}
                error={fieldErrors['shippingAddress.line1']}
                onChange={set(setAddress, 'line1')}
              />
              <Field
                label="Address line 2 (optional)"
                autoComplete="address-line2"
                value={address.line2 ?? ''}
                onChange={set(setAddress, 'line2')}
              />

              <div className="field-grid">
                <Field
                  label="City"
                  autoComplete="address-level2"
                  required
                  value={address.city}
                  error={fieldErrors['shippingAddress.city']}
                  onChange={set(setAddress, 'city')}
                />
                <Field
                  label="State / region"
                  autoComplete="address-level1"
                  value={address.region ?? ''}
                  onChange={set(setAddress, 'region')}
                />
                <Field
                  label="Postal code"
                  autoComplete="postal-code"
                  required
                  value={address.postalCode}
                  error={fieldErrors['shippingAddress.postalCode']}
                  onChange={set(setAddress, 'postalCode')}
                />
                <Field
                  label="Country"
                  autoComplete="country"
                  required
                  maxLength={2}
                  hint="Two-letter code, e.g. US"
                  value={address.country}
                  error={fieldErrors['shippingAddress.country']}
                  onChange={set(setAddress, 'country')}
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="fieldset">
            <legend>Payment</legend>

            <Alert variant="warning">
              This is a simulated gateway. Do not enter a real card number.
            </Alert>

            <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
              <Field
                label="Name on card"
                autoComplete="cc-name"
                required
                value={payment.nameOnCard}
                error={fieldErrors['payment.nameOnCard']}
                onChange={set(setPayment, 'nameOnCard')}
              />
              <Field
                label="Card number"
                inputMode="numeric"
                autoComplete="cc-number"
                required
                value={payment.cardNumber}
                error={fieldErrors['payment.cardNumber']}
                onChange={set(setPayment, 'cardNumber')}
              />

              <div className="field-grid">
                <SelectField
                  label="Expiry month"
                  required
                  value={payment.expMonth || ''}
                  error={fieldErrors['payment.expMonth']}
                  onChange={set(setPayment, 'expMonth')}
                >
                  <option value="">Month</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => (
                    <option key={month} value={month}>
                      {String(month).padStart(2, '0')}
                    </option>
                  ))}
                </SelectField>

                <SelectField
                  label="Expiry year"
                  required
                  value={payment.expYear || ''}
                  error={fieldErrors['payment.expYear']}
                  onChange={set(setPayment, 'expYear')}
                >
                  <option value="">Year</option>
                  {Array.from({ length: 12 }, (_, i) => currentYear + i).map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </SelectField>

                <Field
                  label="Security code"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  required
                  maxLength={4}
                  value={payment.cvc}
                  error={fieldErrors['payment.cvc']}
                  onChange={set(setPayment, 'cvc')}
                />
              </div>

              <p className="test-cards">
                Test cards: <code>4242 4242 4242 4242</code> is approved,{' '}
                <code>4000 0000 0000 0002</code> is declined. Any other number is approved when it
                ends in an even digit.
              </p>
            </div>
          </fieldset>

          <button type="submit" className="btn btn--block" disabled={submitting || cart.hasIssues}>
            {submitting ? 'Placing order…' : `Pay ${formatMoney(cart.totalCents, cart.currency)}`}
          </button>
        </form>

        <aside className="panel summary" aria-label="Order summary">
          <h2>Order summary</h2>

          <ul style={{ listStyle: 'none', margin: '0 0 var(--space-4)', padding: 0 }}>
            {cart.items.map((line) => (
              <li key={line.id} className="spread" style={{ marginBottom: 'var(--space-2)' }}>
                <span style={{ minWidth: 0 }}>
                  {line.name} <span className="muted">× {line.quantity}</span>
                </span>
                <span className="numeric">{formatMoney(line.lineTotalCents, cart.currency)}</span>
              </li>
            ))}
          </ul>

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
        </aside>
      </div>
    </div>
  );
}
