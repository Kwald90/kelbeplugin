// Help center.
//   HQ (staff write drafts; HQ admins publish, unpublish, delete and manage categories):
//     GET    /api/hq/help                      categories and every article (no bodies)
//     POST   /api/hq/help/search               full-text search, drafts included (term in the body)
//     GET    /api/hq/help/articles/:id         one article with its Markdown
//     POST   /api/hq/help/articles             create (a draft unless an admin publishes it)
//     PATCH  /api/hq/help/articles/:id         edit; status needs an HQ admin
//     DELETE /api/hq/help/articles/:id         HQ admin
//     PUT    /api/hq/help/categories/:id       create or rename a category (HQ admin)
//     DELETE /api/hq/help/categories/:id       HQ admin; its articles become uncategorised
//   Signed-in people (published articles only):
//     GET  /api/v1/help/articles[?category=]   list, plus categories and the support address
//     GET  /api/v1/help/articles/:slug         one article
//     POST /api/v1/help/search                 full-text search
// Every HQ change is audited in the platform chain.
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hqAudit, uuidParams } from '../services/hq-common.js';
import { getArticle, listArticles, listCategories, searchArticles, slugify } from '../services/hq-help.js';
import { readPlatformSettings } from '../services/hq-settings.js';

const isAdmin = (req) => req.principal?.platformRole === 'hq_admin';

const articleFields = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,79}$' },
  summary: { type: 'string', maxLength: 300 },
  body: { type: 'string', maxLength: 100000 },
  categoryId: { type: ['string', 'null'], maxLength: 40 },
  status: { type: 'string', enum: ['draft', 'published'] },
  position: { type: 'integer', minimum: 0, maximum: 10000 },
};

/** @param {import('fastify').FastifyInstance} app */
export default async function hqHelpRoutes(app, { db }) {
  const hq = { auth: 'hq' };
  const tags = ['hq'];

  app.get('/api/hq/help', { config: hq, schema: { tags, summary: 'Help categories and every article (drafts included)' } }, async () => {
    return db.withHq(async (c) => ({ categories: await listCategories(c), data: await listArticles(c) }));
  });

  app.post('/api/hq/help/search', {
    config: hq,
    schema: { tags, summary: 'Search help articles, drafts included', body: { type: 'object', required: ['q'], additionalProperties: false, properties: { q: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req) => ({ data: await db.withHq((c) => searchArticles(c, req.body.q)) }));

  app.get('/api/hq/help/articles/:id', { config: hq, schema: { tags, summary: 'One help article with its Markdown', params: uuidParams('id') } }, async (req) => {
    const a = await db.withHq((c) => getArticle(c, { id: req.params.id }));
    if (!a) throw notFound('No such article.');
    return a;
  });

  async function checkCategory(c, id) {
    if (id && !(await c.query('SELECT 1 FROM help_categories WHERE id = $1', [id])).rows.length) throw badRequest('No such category.');
  }
  const uniqueSlug = (e) => { if (e?.code === '23505') throw conflict('Another article already uses this address (slug).'); throw e; };

  app.post('/api/hq/help/articles', {
    config: hq,
    schema: { tags, summary: 'Create a help article (HQ staff: drafts; HQ admins may publish)', body: { type: 'object', required: ['title'], additionalProperties: false, properties: articleFields } },
  }, async (req, reply) => {
    const b = req.body;
    if (b.status === 'published' && !isAdmin(req)) throw forbidden('An HQ admin publishes articles. Save it as a draft.');
    return db.withHq(async (c) => {
      await checkCategory(c, b.categoryId);
      const slug = b.slug || slugify(b.title);
      const { rows } = await c.query(
        `INSERT INTO help_articles (slug, title, summary, body, category_id, status, position, published_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 = 'published' THEN now() END, $8, $8) RETURNING id`,
        [slug, b.title.trim(), b.summary || '', b.body || '', b.categoryId || null, b.status || 'draft', b.position ?? 0, req.principal.userId]).catch(uniqueSlug);
      await hqAudit(c, req, null, { action: 'hq.help_create', collection: 'help_articles', recordId: rows[0].id, summary: `Help article "${b.title.trim().slice(0, 120)}" (${b.status || 'draft'})` });
      reply.code(201);
      return getArticle(c, { id: rows[0].id });
    });
  });

  app.patch('/api/hq/help/articles/:id', {
    config: hq,
    schema: { tags, summary: 'Edit a help article; publishing or unpublishing needs an HQ admin', params: uuidParams('id'), body: { type: 'object', minProperties: 1, additionalProperties: false, properties: articleFields } },
  }, async (req) => {
    const b = req.body;
    return db.withHq(async (c) => {
      const cur = (await c.query('SELECT id, title, status FROM help_articles WHERE id = $1', [req.params.id])).rows[0];
      if (!cur) throw notFound('No such article.');
      if (b.status && b.status !== cur.status && !isAdmin(req)) throw forbidden('An HQ admin publishes and unpublishes articles.');
      // Editing a published article changes what every company reads: admins only.
      if (cur.status === 'published' && !isAdmin(req)) throw forbidden('This article is published. An HQ admin edits published articles; ask one to unpublish it first.');
      if ('categoryId' in b) await checkCategory(c, b.categoryId);
      const map = { title: 'title', slug: 'slug', summary: 'summary', body: 'body', categoryId: 'category_id', status: 'status', position: 'position' };
      const sets = [];
      const params = [cur.id];
      for (const [k, col] of Object.entries(map)) {
        if (!(k in b)) continue;
        params.push(k === 'title' ? b.title.trim() : b[k]);
        sets.push(`${col} = $${params.length}`);
      }
      if (b.status === 'published' && cur.status !== 'published') sets.push('published_at = now()');
      params.push(req.principal.userId);
      await c.query(`UPDATE help_articles SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now() WHERE id = $1`, params).catch(uniqueSlug);
      const what = b.status && b.status !== cur.status ? (b.status === 'published' ? 'published' : 'unpublished') : 'edited';
      await hqAudit(c, req, null, { action: `hq.help_${what === 'edited' ? 'update' : what === 'published' ? 'publish' : 'unpublish'}`, collection: 'help_articles', recordId: cur.id, summary: `Help article "${(b.title || cur.title).slice(0, 120)}" ${what}`, meta: { fields: Object.keys(b) } });
      return getArticle(c, { id: cur.id });
    });
  });

  app.delete('/api/hq/help/articles/:id', { config: hq, schema: { tags, summary: 'Delete a help article (HQ admin)', params: uuidParams('id') } }, async (req, reply) => {
    if (!isAdmin(req)) throw forbidden('An HQ admin has to do this.');
    await db.withHq(async (c) => {
      const { rows } = await c.query('DELETE FROM help_articles WHERE id = $1 RETURNING title', [req.params.id]);
      if (!rows[0]) throw notFound('No such article.');
      await hqAudit(c, req, null, { action: 'hq.help_delete', collection: 'help_articles', recordId: req.params.id, summary: `Deleted help article "${rows[0].title.slice(0, 120)}"` });
    });
    reply.code(204);
  });

  const catParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$' } } };

  app.put('/api/hq/help/categories/:id', {
    config: hq,
    schema: {
      tags, summary: 'Create or change a help category (HQ admin)', params: catParams,
      body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, description: { type: 'string', maxLength: 300 }, position: { type: 'integer', minimum: 0, maximum: 1000 } } },
    },
  }, async (req) => {
    if (!isAdmin(req)) throw forbidden('An HQ admin has to do this.');
    return db.withHq(async (c) => {
      await c.query(
        `INSERT INTO help_categories (id, name, description, position) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, position = EXCLUDED.position, updated_at = now()`,
        [req.params.id, req.body.name.trim(), req.body.description || '', req.body.position ?? 0]);
      await hqAudit(c, req, null, { action: 'hq.help_category_set', collection: 'help_categories', recordId: req.params.id, summary: `Help category ${req.params.id}: ${req.body.name.trim()}` });
      return { categories: await listCategories(c) };
    });
  });

  app.delete('/api/hq/help/categories/:id', { config: hq, schema: { tags, summary: 'Delete a help category (HQ admin)', params: catParams } }, async (req, reply) => {
    if (!isAdmin(req)) throw forbidden('An HQ admin has to do this.');
    await db.withHq(async (c) => {
      const { rows } = await c.query('DELETE FROM help_categories WHERE id = $1 RETURNING name', [req.params.id]);
      if (!rows[0]) throw notFound('No such category.');
      await hqAudit(c, req, null, { action: 'hq.help_category_delete', collection: 'help_categories', recordId: req.params.id, summary: `Deleted help category ${rows[0].name}` });
    });
    reply.code(204);
  });

  // ---- in the app (published only) ----------------------------------------------------

  const member = { auth: 'tenant', apiKey: false };

  app.get('/api/v1/help/articles', {
    config: member,
    schema: { tags: ['help'], summary: 'Published help articles (no bodies), categories and the support address', querystring: { type: 'object', additionalProperties: false, properties: { category: { type: 'string', maxLength: 40 } } } },
  }, async (req) => {
    const [categories, data, settings] = await Promise.all([
      listCategories(db, { published: true }), listArticles(db, { published: true, category: req.query.category || null }), readPlatformSettings(db),
    ]);
    return { categories: categories.filter((c) => c.articles > 0), data, support: { email: settings.support.email } };
  });

  app.get('/api/v1/help/articles/:slug', {
    config: member,
    schema: { tags: ['help'], summary: 'One published help article', params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,79}$' } } } },
  }, async (req) => {
    const a = await getArticle(db, { slug: req.params.slug, published: true });
    if (!a) throw notFound('No such article.');
    return a;
  });

  app.post('/api/v1/help/search', {
    config: member,
    schema: { tags: ['help'], summary: 'Search published help articles', body: { type: 'object', required: ['q'], additionalProperties: false, properties: { q: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req) => ({ data: await searchArticles(db, req.body.q, { published: true }) }));
}
