import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { cart as cartApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import type { Cart } from '../api/types';
import { useAuth } from './AuthContext';

interface CartState {
  cart: Cart | null;
  loading: boolean;
  /** Set when the last mutation failed, e.g. not enough stock. */
  error: string | null;
  itemCount: number;
  addItem: (productId: string, quantity?: number) => Promise<void>;
  updateItem: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  reload: () => Promise<void>;
  clearError: () => void;
}

const CartContext = createContext<CartState | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const { user, initialising } = useAuth();
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setCart(await cartApi.get());
    } catch {
      // A cart read failing should not take the page down; the header simply
      // shows no badge until the next successful call.
      setCart(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload whenever the signed-in identity changes. Signing in merges the guest
  // cart server-side, so the client must re-read rather than keep its copy.
  // Waiting for `initialising` avoids a wasted guest fetch on first paint.
  useEffect(() => {
    if (initialising) return;
    void reload();
  }, [user?.id, initialising, reload]);

  const run = useCallback(async (op: () => Promise<Cart>) => {
    setError(null);
    try {
      setCart(await op());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      throw err;
    }
  }, []);

  const addItem = useCallback(
    (productId: string, quantity = 1) => run(() => cartApi.addItem(productId, quantity)),
    [run],
  );

  const updateItem = useCallback(
    (itemId: string, quantity: number) => run(() => cartApi.updateItem(itemId, quantity)),
    [run],
  );

  const removeItem = useCallback(
    (itemId: string) => run(() => cartApi.removeItem(itemId)),
    [run],
  );

  const value = useMemo<CartState>(
    () => ({
      cart,
      loading,
      error,
      itemCount: cart?.itemCount ?? 0,
      addItem,
      updateItem,
      removeItem,
      reload,
      clearError: () => setError(null),
    }),
    [cart, loading, error, addItem, updateItem, removeItem, reload],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside CartProvider');
  return ctx;
}
