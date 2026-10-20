-- 0081 Help center: articles HQ writes in Markdown, grouped in categories, that signed-in
-- people read in the app (#/help, GET /api/v1/help/articles). Drafts are HQ-only: the API
-- filters on status, and RLS on the app role only ever returns published articles.

CREATE TABLE help_categories (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  position    integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE help_articles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary      text NOT NULL DEFAULT '' CHECK (length(summary) <= 300),
  body         text NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  category_id  text REFERENCES help_categories (id) ON DELETE SET NULL ON UPDATE CASCADE,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  position     integer NOT NULL DEFAULT 0,
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english', title), 'A')
                 || setweight(to_tsvector('english', summary), 'B')
                 || setweight(to_tsvector('english', body), 'C')) STORED,
  published_at timestamptz,
  created_by   uuid,
  updated_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX help_articles_search_idx ON help_articles USING gin (search);
CREATE INDEX help_articles_category_idx ON help_articles (category_id, position);

-- Not FORCE: the owner seeds articles in migrations. The app role sees published ones only.
ALTER TABLE help_articles ENABLE ROW LEVEL SECURITY;
CREATE POLICY help_articles_published ON help_articles FOR SELECT TO fishtape_app USING (status = 'published');

GRANT SELECT ON help_categories, help_articles TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON help_categories, help_articles TO fishtape_hq;
