import { NavLink, Link, Outlet } from 'react-router-dom';
import { useAuth } from '../store/AuthContext';
import { useCart } from '../store/CartContext';

function Header() {
  const { user, isAdmin, logout } = useAuth();
  const { itemCount } = useCart();

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link to="/" className="brand">
          Web Store
        </Link>

        <nav className="site-nav" aria-label="Main">
          <NavLink to="/">Shop</NavLink>

          {user ? (
            <>
              <NavLink to="/orders">Orders</NavLink>
              {isAdmin && <NavLink to="/admin">Admin</NavLink>}
              <button type="button" className="btn btn--ghost" onClick={() => void logout()}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login">Sign in</NavLink>
              <NavLink to="/register">Create account</NavLink>
            </>
          )}

          <NavLink to="/cart" className="cart-link">
            Cart
            {itemCount > 0 && (
              <>
                <span className="badge" aria-hidden="true">
                  {itemCount}
                </span>
                <span className="visually-hidden">{itemCount} items in cart</span>
              </>
            )}
          </NavLink>
        </nav>
      </div>
    </header>
  );
}

export function Layout() {
  return (
    <div className="site">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <Header />

      <main id="main" className="site-main" tabIndex={-1}>
        <div className="container">
          <Outlet />
        </div>
      </main>

      <footer className="site-footer">
        <div className="container">
          <p style={{ margin: 0 }}>
            Web Store — demo storefront. Payments are simulated; no real card is ever charged.
          </p>
        </div>
      </footer>
    </div>
  );
}
