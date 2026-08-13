import { buildQuery, request } from './client';
import type {
  AdminOrder,
  AdminProduct,
  Address,
  Cart,
  CategoryNode,
  Order,
  OrderStatus,
  Paginated,
  PaymentDetails,
  ProductDetail,
  ProductQuery,
  ProductSummary,
  Quote,
  User,
} from './types';

export const auth = {
  register: (body: { email: string; password: string; firstName?: string; lastName?: string }) =>
    request<{ user: User; accessToken: string }>('/auth/register', { method: 'POST', body }),

  login: (body: { email: string; password: string }) =>
    request<{ user: User; accessToken: string }>('/auth/login', { method: 'POST', body }),

  logout: () => request<null>('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User }>('/auth/me'),

  forgotPassword: (body: { email: string }) =>
    request<{ message: string; devToken?: string }>('/auth/forgot-password', {
      method: 'POST',
      body,
    }),

  resetPassword: (body: { token: string; password: string }) =>
    request<{ message: string }>('/auth/reset-password', { method: 'POST', body }),
};

export const catalog = {
  products: (query: ProductQuery = {}) =>
    request<Paginated<ProductSummary>>(`/products${buildQuery({ ...query })}`),

  product: (slug: string) => request<ProductDetail>(`/products/${slug}`),

  categories: () => request<{ categories: CategoryNode[] }>('/categories'),
};

export const cart = {
  get: () => request<Cart>('/cart'),

  addItem: (productId: string, quantity = 1) =>
    request<Cart>('/cart/items', { method: 'POST', body: { productId, quantity } }),

  updateItem: (itemId: string, quantity: number) =>
    request<Cart>(`/cart/items/${itemId}`, { method: 'PATCH', body: { quantity } }),

  removeItem: (itemId: string) => request<Cart>(`/cart/items/${itemId}`, { method: 'DELETE' }),

  clear: () => request<Cart>('/cart', { method: 'DELETE' }),
};

export const checkout = {
  quote: () => request<Quote>('/checkout/quote', { method: 'POST' }),

  placeOrder: (body: {
    email?: string;
    shippingAddress: Address;
    billingAddress?: Address;
    payment: PaymentDetails;
  }) => request<{ order: Order }>('/checkout/orders', { method: 'POST', body }),
};

export const orders = {
  list: (page = 1, pageSize = 10) =>
    request<Paginated<Order>>(`/orders${buildQuery({ page, pageSize })}`),

  get: (orderNumber: string) => request<Order>(`/orders/${orderNumber}`),
};

export const admin = {
  products: (query: { q?: string; includeInactive?: boolean; page?: number; pageSize?: number }) =>
    request<Paginated<AdminProduct>>(`/admin/products${buildQuery({ ...query })}`),

  product: (id: string) => request<AdminProduct>(`/admin/products/${id}`),

  createProduct: (body: Record<string, unknown>) =>
    request<AdminProduct>('/admin/products', { method: 'POST', body }),

  updateProduct: (id: string, body: Record<string, unknown>) =>
    request<AdminProduct>(`/admin/products/${id}`, { method: 'PATCH', body }),

  deleteProduct: (id: string) => request<AdminProduct>(`/admin/products/${id}`, { method: 'DELETE' }),

  createCategory: (body: Record<string, unknown>) =>
    request<CategoryNode>('/admin/categories', { method: 'POST', body }),

  orders: (query: { status?: OrderStatus; email?: string; page?: number; pageSize?: number }) =>
    request<Paginated<AdminOrder>>(`/admin/orders${buildQuery({ ...query })}`),

  updateOrderStatus: (id: string, status: OrderStatus) =>
    request<AdminOrder>(`/admin/orders/${id}/status`, { method: 'PATCH', body: { status } }),
};
