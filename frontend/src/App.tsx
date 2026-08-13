import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './store/AuthContext';
import { CartProvider } from './store/CartContext';
import { CatalogPage } from './routes/CatalogPage';
import { ProductPage } from './routes/ProductPage';
import { CartPage } from './routes/CartPage';
import { CheckoutPage } from './routes/CheckoutPage';
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
} from './routes/auth-pages';
import {
  OrderConfirmationPage,
  OrderDetailPage,
  OrdersPage,
} from './routes/order-pages';
import {
  AdminLayout,
  AdminOrdersPage,
  AdminProductsPage,
  NotFoundPage,
} from './routes/admin-pages';

export function App() {
  return (
    <AuthProvider>
      <CartProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<CatalogPage />} />
            <Route path="products/:slug" element={<ProductPage />} />
            <Route path="cart" element={<CartPage />} />
            <Route path="checkout" element={<CheckoutPage />} />

            <Route path="login" element={<LoginPage />} />
            <Route path="register" element={<RegisterPage />} />
            <Route path="forgot-password" element={<ForgotPasswordPage />} />
            <Route path="reset-password" element={<ResetPasswordPage />} />

            {/* Reachable by guests: the order arrives via navigation state. */}
            <Route
              path="orders/confirmation/:orderNumber"
              element={<OrderConfirmationPage />}
            />

            <Route
              path="orders"
              element={
                <RequireAuth>
                  <OrdersPage />
                </RequireAuth>
              }
            />
            <Route
              path="orders/:orderNumber"
              element={
                <RequireAuth>
                  <OrderDetailPage />
                </RequireAuth>
              }
            />

            <Route
              path="admin"
              element={
                <RequireAuth adminOnly>
                  <AdminLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="products" replace />} />
              <Route path="products" element={<AdminProductsPage />} />
              <Route path="orders" element={<AdminOrdersPage />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </CartProvider>
    </AuthProvider>
  );
}
