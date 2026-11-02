-- 0163 Platform secrets: Fishtape's OWN keys (its SendGrid/Resend and its Stripe account),
-- set by an HQ admin in the HQ console instead of only in the server .env. Values are
-- envelope-encrypted (lib/crypto.js) with the secret name bound in as associated data, so a
-- sealed value can't be copied under another name. This is platform-wide config, not a company's
-- key (those live in tenant_secrets, 0001) -- so no tenant_id and no row-level security. The app
-- and worker read it to resolve keys at boot (DB value overrides env); only HQ writes it.
CREATE TABLE platform_secrets (
  name        text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9]*(\.[a-z0-9_]+){1,3}$'),
  value_enc   text NOT NULL,                 -- envelopeSeal() output; plaintext never stored
  hint        text NOT NULL DEFAULT '',      -- last 4 chars (or the whole value for non-secret settings)
  updated_by  uuid,                          -- the HQ user who last set it (platform_users.id)
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON platform_secrets TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_secrets TO fishtape_hq;
