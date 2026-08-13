import { Link, useLocation, useParams } from 'react-router-dom';
import { orders } from '../api/endpoints';
import type { Address, Order } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { formatDate, formatMoney, orderStatusLabel } from '../lib/format';
import { Alert, EmptyState, LoadingBlock, StatusPill } from '../components/ui';

function AddressBlock({ address }: { address: Address }) {
  return (
    <address style={{ fontStyle: 'normal' }}>
      {address.fullName}
      <br />
      {address.line1}
      <br />
      {address.line2 && (
        <>
          {address.line2}
          <br />
        </>
      )}
      {address.city}
      {address.region ? `, ${address.region}` : ''} {address.postalCode}
      <br />
      {address.country}
    </address>
  );
}

function OrderDetail({ order }: { order: Order }) {
  return (
    <div className="stack">
      <div className="panel stack">
        <div className="spread">
          <div>
            <h2 style={{ marginBottom: 0 }}>{order.orderNumber}</h2>
            <p className="muted" style={{ margin: 0 }}>
              Placed {formatDate(order.placedAt)}
            </p>
          </div>
          <StatusPill status={order.status} label={orderStatusLabel(order.status)} />
        </div>

        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Items in order {order.orderNumber}</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">SKU</th>
                <th scope="col" className="numeric">
                  Unit price
                </th>
                <th scope="col" className="numeric">
                  Qty
                </th>
                <th scope="col" className="numeric">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td style={{ whiteSpace: 'normal' }}>{item.productName}</td>
                  <td>{item.sku}</td>
                  <td className="numeric">{formatMoney(item.unitPriceCents, order.currency)}</td>
                  <td className="numeric">{item.quantity}</td>
                  <td className="numeric">{formatMoney(item.lineTotalCents, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="field-grid">
          <div>
            <h3>Shipping to</h3>
            <AddressBlock address={order.shippingAddress} />
          </div>

          <div>
            <h3>Totals</h3>
            <dl className="summary">
              <dt>Subtotal</dt>
              <dd>{formatMoney(order.subtotalCents, order.currency)}</dd>
              <dt>Shipping</dt>
              <dd>
                {order.shippingCents === 0
                  ? 'Free'
                  : formatMoney(order.shippingCents, order.currency)}
              </dd>
              <dt>Tax</dt>
              <dd>{formatMoney(order.taxCents, order.currency)}</dd>
              <dt>
                <strong>Total</strong>
              </dt>
              <dd>
                <strong>{formatMoney(order.totalCents, order.currency)}</strong>
              </dd>
            </dl>
            {order.payment?.reference && (
              <p className="muted" style={{ fontSize: '0.85rem' }}>
                Payment reference {order.payment.reference} (simulated)
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown straight after checkout. The order arrives via navigation state so a
 * guest — who cannot fetch their order later — still sees a confirmation.
 */
export function OrderConfirmationPage() {
  const { orderNumber = '' } = useParams();
  const location = useLocation() as { state?: { order?: Order } };
  const order = location.state?.order;

  return (
    <div className="stack">
      <Alert variant="success">
        <strong>Thank you — your order is confirmed.</strong>
      </Alert>

      {order ? (
        <OrderDetail order={order} />
      ) : (
        <EmptyState title={`Order ${orderNumber}`}>
          <p>
            This confirmation is no longer in view. If you have an account you can find it in{' '}
            <Link to="/orders">your order history</Link>.
          </p>
        </EmptyState>
      )}

      <p>
        <Link to="/" className="btn btn--secondary">
          Continue shopping
        </Link>
      </p>
    </div>
  );
}

export function OrdersPage() {
  const { data, loading, error } = useAsync(() => orders.list(1, 20), []);

  if (loading && !data) return <LoadingBlock label="Loading your orders" />;
  if (error) return <Alert>{error}</Alert>;

  if (!data || data.items.length === 0) {
    return (
      <EmptyState title="No orders yet">
        <p>
          When you place an order it will appear here. <Link to="/">Start shopping</Link>.
        </p>
      </EmptyState>
    );
  }

  return (
    <div className="stack">
      <h1>Your orders</h1>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Placed</th>
              <th scope="col">Status</th>
              <th scope="col" className="numeric">
                Items
              </th>
              <th scope="col" className="numeric">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link to={`/orders/${order.orderNumber}`}>{order.orderNumber}</Link>
                </td>
                <td>{formatDate(order.placedAt)}</td>
                <td>
                  <StatusPill status={order.status} label={orderStatusLabel(order.status)} />
                </td>
                <td className="numeric">
                  {order.items.reduce((sum, item) => sum + item.quantity, 0)}
                </td>
                <td className="numeric">{formatMoney(order.totalCents, order.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OrderDetailPage() {
  const { orderNumber = '' } = useParams();
  const { data, loading, error } = useAsync(() => orders.get(orderNumber), [orderNumber]);

  if (loading && !data) return <LoadingBlock label="Loading order" />;
  if (error) {
    return (
      <EmptyState title="Order not available">
        <p>{error}</p>
        <p>
          <Link to="/orders">Back to your orders</Link>
        </p>
      </EmptyState>
    );
  }
  if (!data) return null;

  return (
    <div className="stack">
      <nav aria-label="Breadcrumb">
        <Link to="/orders">← Back to your orders</Link>
      </nav>
      <h1>Order {data.orderNumber}</h1>
      <OrderDetail order={data} />
    </div>
  );
}
