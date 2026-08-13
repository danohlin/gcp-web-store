-- Include category names in product search.
--
-- Searching "coffee" previously returned nothing even though a Coffee category
-- existed, because the vector only covered name, SKU and description and none
-- of those products literally say "coffee".
--
-- Category names live in another table, so a trigger on `products` alone is not
-- enough: at INSERT time the product_categories rows do not exist yet, and a
-- product can be re-categorised or a category renamed long after the product
-- row last changed. Three triggers therefore feed the same builder function.

-- Reads other tables, so STABLE rather than IMMUTABLE. That is fine because the
-- result is stored in a column; it is never used as an index expression.
CREATE OR REPLACE FUNCTION products_build_search_vector(
  p_product_id uuid,
  p_name       text,
  p_sku        text,
  p_description text
) RETURNS tsvector AS $$
  SELECT
    setweight(to_tsvector('english', coalesce(p_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(p_sku, '')), 'B') ||
    -- Category names sit at weight B: a stronger signal than a passing mention
    -- in the description, weaker than the product's own name.
    setweight(to_tsvector('english', coalesce((
      SELECT string_agg(c.name, ' ')
      FROM product_categories pc
      JOIN categories c ON c.id = pc.category_id
      WHERE pc.product_id = p_product_id
    ), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(p_description, '')), 'C');
$$ LANGUAGE sql STABLE;

-- 1. The product's own columns changed.
CREATE OR REPLACE FUNCTION products_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := products_build_search_vector(
    NEW.id, NEW.name, NEW.sku, NEW.description
  );
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- 2. A product was added to or removed from a category.
--    This UPDATE touches only search_vector, and the trigger above is scoped to
--    UPDATE OF name, sku, description — so there is no recursion.
CREATE OR REPLACE FUNCTION product_categories_search_refresh() RETURNS trigger AS $$
DECLARE
  target uuid := COALESCE(NEW.product_id, OLD.product_id);
BEGIN
  UPDATE products p
     SET search_vector = products_build_search_vector(p.id, p.name, p.sku, p.description)
   WHERE p.id = target;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_categories_search_trigger
  AFTER INSERT OR DELETE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION product_categories_search_refresh();

-- 3. A category was renamed: refresh every product filed under it.
CREATE OR REPLACE FUNCTION categories_search_refresh() RETURNS trigger AS $$
BEGIN
  UPDATE products p
     SET search_vector = products_build_search_vector(p.id, p.name, p.sku, p.description)
   WHERE p.id IN (
     SELECT pc.product_id FROM product_categories pc WHERE pc.category_id = NEW.id
   );
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER categories_search_trigger
  AFTER UPDATE OF name ON categories
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION categories_search_refresh();

-- Backfill every existing product now that categories count.
UPDATE products p
   SET search_vector = products_build_search_vector(p.id, p.name, p.sku, p.description);
