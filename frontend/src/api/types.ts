/** Response shapes mirroring the backend API. */

export type Role = 'CUSTOMER' | 'ADMIN';

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: Role;
  createdAt: string;
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  productCount: number;
  children: CategoryNode[];
}

export interface ProductSummary {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  stockQty: number;
  inStock: boolean;
  imageUrl: string | null;
  categories: { id: string; name: string; slug: string }[];
}

export interface ProductDetail extends ProductSummary {
  images: { id: string; url: string; alt: string; position: number }[];
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CartLine {
  id: string;
  productId: string;
  slug: string;
  name: string;
  sku: string;
  imageUrl: string | null;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  availableQty: number;
  exceedsStock: boolean;
}

export interface Cart {
  id: string;
  currency: string;
  items: CartLine[];
  itemCount: number;
  hasIssues: boolean;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}

export interface Quote extends Cart {
  canCheckout: boolean;
}

export interface Address {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface PaymentDetails {
  cardNumber: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  nameOnCard: string;
}

export interface OrderLine {
  id: string;
  productId: string | null;
  productName: string;
  sku: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  email: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  shippingAddress: Address;
  billingAddress: Address | null;
  placedAt: string;
  items: OrderLine[];
  payment: {
    status: string;
    provider: string;
    reference: string | null;
    failureCode: string | null;
  } | null;
}

export interface ProductQuery {
  q?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'name_asc';
  page?: number;
  pageSize?: number;
  inStockOnly?: boolean;
}

/** Admin-facing product shape, which includes inactive records. */
export interface AdminProduct extends Omit<ProductSummary, 'inStock' | 'imageUrl' | 'categories'> {
  isActive: boolean;
  images: { id: string; url: string; alt: string; position: number }[];
  categories: { category: { id: string; name: string; slug: string } }[];
}

export interface AdminOrder extends Omit<Order, 'payment'> {
  userId: string | null;
  payments: { status: string; provider: string; providerRef: string | null }[];
}
