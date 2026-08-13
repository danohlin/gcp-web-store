import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { admin } from '../api/endpoints';
import { ApiError } from '../api/client';
import type { AdminProduct, OrderStatus } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { formatDate, formatMoney, orderStatusLabel } from '../lib/format';
import { Alert, Field, LoadingBlock, Pagination, SelectField, StatusPill } from '../components/ui';

export function AdminLayout() {
  return (
    <div className="stack">
      <h1>Admin</h1>
      <nav className="site-nav" style={{ marginLeft: 0 }} aria-label="Admin sections">
        <NavLink to="/admin/products" end>
          Products
        </NavLink>
        <NavLink to="/admin/orders">Orders</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}

const BLANK_PRODUCT = {
  sku: '',
  name: '',
  description: '',
  priceCents: '',
  stockQty: '',
};

export function AdminProductsPage() {
  const [page, setPage] = useState(1);
  const [showInactive, setShowInactive] = useState(true);
  const [form, setForm] = useState(BLANK_PRODUCT);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const { data, loading, reload } = useAsync(
    () => admin.products({ page, pageSize: 20, includeInactive: showInactive }),
    [page, showInactive],
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setCreating(true);
    try {
      await admin.createProduct({
        sku: form.sku,
        name: form.name,
        description: form.description,
        priceCents: Number(form.priceCents),
        stockQty: Number(form.stockQty),
      });
      setForm(BLANK_PRODUCT);
      setNotice('Product created.');
      reload();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Could not create the product.');
      }
    } finally {
      setCreating(false);
    }
  }

  async function adjustStock(product: AdminProduct, delta: number) {
    setError(null);
    try {
      await admin.updateProduct(product.id, { stockQty: Math.max(0, product.stockQty + delta) });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update stock.');
    }
  }

  async function retire(product: AdminProduct) {
    setError(null);
    try {
      await admin.deleteProduct(product.id);
      setNotice(`"${product.name}" retired.`);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not retire the product.');
    }
  }

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="stack">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert variant="success">{notice}</Alert>}

      <details className="panel">
        <summary style={{ cursor: 'pointer', fontWeight: 650 }}>Add a product</summary>
        <form className="stack" style={{ marginTop: 'var(--space-4)' }} onSubmit={(e) => void handleCreate(e)}>
          <div className="field-grid">
            <Field label="SKU" required value={form.sku} error={fieldErrors.sku} onChange={update('sku')} />
            <Field label="Name" required value={form.name} error={fieldErrors.name} onChange={update('name')} />
            <Field
              label="Price (cents)"
              type="number"
              min={0}
              required
              hint="1999 = $19.99"
              value={form.priceCents}
              error={fieldErrors.priceCents}
              onChange={update('priceCents')}
            />
            <Field
              label="Stock quantity"
              type="number"
              min={0}
              required
              value={form.stockQty}
              error={fieldErrors.stockQty}
              onChange={update('stockQty')}
            />
          </div>
          <Field
            label="Description"
            value={form.description}
            error={fieldErrors.description}
            onChange={update('description')}
          />
          <button type="submit" className="btn" disabled={creating}>
            {creating ? 'Creating…' : 'Create product'}
          </button>
        </form>
      </details>

      <label className="row" style={{ gap: 'var(--space-2)' }}>
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
        />
        Show retired products
      </label>

      {loading && !data ? (
        <LoadingBlock label="Loading products" />
      ) : !data ? null : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">SKU</th>
                  <th scope="col" className="numeric">
                    Price
                  </th>
                  <th scope="col" className="numeric">
                    Stock
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((product) => (
                  <tr key={product.id}>
                    <td style={{ whiteSpace: 'normal' }}>{product.name}</td>
                    <td>{product.sku}</td>
                    <td className="numeric">{formatMoney(product.priceCents, product.currency)}</td>
                    <td className="numeric">{product.stockQty}</td>
                    <td>
                      <span className={`pill ${product.isActive ? 'pill--paid' : 'pill--cancelled'}`}>
                        {product.isActive ? 'Active' : 'Retired'}
                      </span>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 'var(--space-1)' }}>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => void adjustStock(product, 10)}
                        >
                          +10
                          <span className="visually-hidden"> stock for {product.name}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => void adjustStock(product, -10)}
                          disabled={product.stockQty === 0}
                        >
                          −10
                          <span className="visually-hidden"> stock for {product.name}</span>
                        </button>
                        {product.isActive && (
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => void retire(product)}
                          >
                            Retire
                            <span className="visually-hidden"> {product.name}</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
        </>
      )}
    </div>
  );
}

const NEXT_STATUSES: Record<string, OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['PROCESSING', 'CANCELLED', 'REFUNDED'],
  PROCESSING: ['SHIPPED', 'CANCELLED', 'REFUNDED'],
  SHIPPED: ['DELIVERED', 'REFUNDED'],
  DELIVERED: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
};

export function AdminOrdersPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const { data, loading, reload } = useAsync(
    () =>
      admin.orders({
        page,
        pageSize: 20,
        ...(status ? { status: status as OrderStatus } : {}),
      }),
    [page, status],
  );

  async function changeStatus(id: string, next: OrderStatus) {
    setError(null);
    try {
      await admin.updateOrderStatus(id, next);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the order.');
    }
  }

  return (
    <div className="stack">
      {error && <Alert>{error}</Alert>}

      <div className="toolbar">
        <SelectField
          label="Filter by status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {Object.keys(NEXT_STATUSES).map((key) => (
            <option key={key} value={key}>
              {orderStatusLabel(key)}
            </option>
          ))}
        </SelectField>
      </div>

      {loading && !data ? (
        <LoadingBlock label="Loading orders" />
      ) : !data || data.items.length === 0 ? (
        <p className="muted">No orders match this filter.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Placed</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="numeric">
                    Total
                  </th>
                  <th scope="col">Advance to</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((order) => (
                  <tr key={order.id}>
                    <td>{order.orderNumber}</td>
                    <td>{formatDate(order.placedAt)}</td>
                    <td>{order.email}</td>
                    <td>
                      <StatusPill status={order.status} label={orderStatusLabel(order.status)} />
                    </td>
                    <td className="numeric">{formatMoney(order.totalCents, order.currency)}</td>
                    <td>
                      <div className="row" style={{ gap: 'var(--space-1)' }}>
                        {(NEXT_STATUSES[order.status] ?? []).map((next) => (
                          <button
                            key={next}
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => void changeStatus(order.id, next)}
                          >
                            {orderStatusLabel(next)}
                            <span className="visually-hidden"> for order {order.orderNumber}</span>
                          </button>
                        ))}
                        {(NEXT_STATUSES[order.status] ?? []).length === 0 && (
                          <span className="muted">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
        </>
      )}
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="empty-state stack">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to the shop</Link>
      </p>
    </div>
  );
}
