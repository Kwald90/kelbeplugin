// Help center articles (help_articles, help_categories). HQ reads everything with the HQ
// role; the app reads with the app role, where RLS and the queries below only ever return
// published articles.

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'article';

/** ts_headline output as plain text: no <b> marks, no Markdown symbols. */
export const plainSnippet = (s) => String(s).replace(/<\/?b>/g, '').replace(/[#*`>|_]+/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 300);

const ARTICLE_COLS = `a.id, a.slug, a.title, a.summary, a.category_id, c.name AS category_name, a.status, a.position,
  a.published_at, a.created_at, a.updated_at, length(a.body) AS body_length`;

export function articleView(a, { body = false } = {}) {
  return {
    id: a.id, slug: a.slug, title: a.title, summary: a.summary, categoryId: a.category_id, categoryName: a.category_name || null,
    status: a.status, position: a.position, publishedAt: a.published_at ? new Date(a.published_at).toISOString() : null,
    updatedAt: new Date(a.updated_at).toISOString(), ...(body ? { body: a.body } : {}), ...(a.rank != null ? { rank: Number(a.rank) } : {}),
    ...(a.snippet ? { snippet: plainSnippet(a.snippet) } : {}),
  };
}

export async function listCategories(q, { published = false } = {}) {
  const { rows } = await q.query(
    `SELECT c.id, c.name, c.description, c.position,
            (SELECT count(*)::int FROM help_articles a WHERE a.category_id = c.id ${published ? "AND a.status = 'published'" : ''}) AS articles
       FROM help_categories c ORDER BY c.position, c.name`);
  return rows.map((c) => ({ id: c.id, name: c.name, description: c.description, position: c.position, articles: c.articles }));
}

/**
 * Articles without bodies. `published` limits to published ones (always true for the app).
 * @param {{ query: Function }} q
 */
export async function listArticles(q, { published = false, category = null } = {}) {
  const { rows } = await q.query(
    `SELECT ${ARTICLE_COLS} FROM help_articles a LEFT JOIN help_categories c ON c.id = a.category_id
      WHERE ($1::boolean IS FALSE OR a.status = 'published') AND ($2::text IS NULL OR a.category_id = $2)
      ORDER BY c.position NULLS LAST, a.position, a.title`, [published, category]);
  return rows.map((a) => articleView(a));
}

export async function getArticle(q, { slug = null, id = null, published = false }) {
  const { rows } = await q.query(
    `SELECT ${ARTICLE_COLS}, a.body FROM help_articles a LEFT JOIN help_categories c ON c.id = a.category_id
      WHERE ($1::text IS NULL OR a.slug = $1) AND ($2::uuid IS NULL OR a.id = $2) AND ($3::boolean IS FALSE OR a.status = 'published')`,
    [slug, id, published]);
  return rows[0] ? articleView(rows[0], { body: true }) : null;
}

/**
 * Full-text search (title weighs most, then summary, then body), with a plain substring
 * match on the title as a fallback for short or partial words.
 */
export async function searchArticles(q, term, { published = false, limit = 20 } = {}) {
  const t = String(term || '').trim().slice(0, 200);
  if (!t) return [];
  const like = `%${t.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { rows } = await q.query(
    `SELECT ${ARTICLE_COLS},
            ts_rank(a.search, websearch_to_tsquery('english', $1)) + CASE WHEN lower(a.title) LIKE $2 THEN 1 ELSE 0 END AS rank,
            ts_headline('english', a.body, websearch_to_tsquery('english', $1), 'MaxWords=24, MinWords=8, MaxFragments=1') AS snippet
       FROM help_articles a LEFT JOIN help_categories c ON c.id = a.category_id
      WHERE ($3::boolean IS FALSE OR a.status = 'published')
        AND (a.search @@ websearch_to_tsquery('english', $1) OR lower(a.title) LIKE $2 OR lower(a.summary) LIKE $2)
      ORDER BY rank DESC, a.title LIMIT $4`, [t, like, published, limit]);
  return rows.map((a) => articleView(a));
}
