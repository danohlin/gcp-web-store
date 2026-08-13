-- Full-text search support, plus invariants Prisma's schema language cannot
-- express. Kept as a separate migration so `prisma migrate diff` against the
-- schema stays clean.

-- ---------------------------------------------------------------------------
-- Product full-text search
-- ---------------------------------------------------------------------------
-- `search_vector` is maintained by a trigger rather than a generated column so
-- that weights can be applied: a match on the product name should outrank a
-- match buried in the description.

CREATE OR REPLACE FUNCTION products_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.sku, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name, sku, description ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_vector_update();

-- Backfill any rows that predate the trigger.
UPDATE products SET search_vector =
  setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(sku, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'C');

CREATE INDEX products_search_vector_idx ON products USING GIN (search_vector);

-- ---------------------------------------------------------------------------
-- Cart invariants
-- ---------------------------------------------------------------------------
-- A user may have at most one ACTIVE cart. Converted and abandoned carts are
-- retained for history, so this has to be a partial index.
CREATE UNIQUE INDEX carts_one_active_per_user_idx
  ON carts (user_id)
  WHERE status = 'ACTIVE' AND user_id IS NOT NULL;

-- Every cart must be reachable by exactly one identity.
ALTER TABLE carts ADD CONSTRAINT carts_owner_present
  CHECK (user_id IS NOT NULL OR session_token IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Value invariants
-- ---------------------------------------------------------------------------
ALTER TABLE cart_items ADD CONSTRAINT cart_items_quantity_positive
  CHECK (quantity > 0);

ALTER TABLE order_items ADD CONSTRAINT order_items_quantity_positive
  CHECK (quantity > 0);

-- Guards the conditional decrement in the checkout transaction: if two orders
-- race for the last unit, the loser violates this constraint and rolls back.
ALTER TABLE products ADD CONSTRAINT products_stock_non_negative
  CHECK (stock_qty >= 0);

ALTER TABLE products ADD CONSTRAINT products_price_non_negative
  CHECK (price_cents >= 0);

ALTER TABLE orders ADD CONSTRAINT orders_total_non_negative
  CHECK (total_cents >= 0 AND subtotal_cents >= 0 AND shipping_cents >= 0 AND tax_cents >= 0);
