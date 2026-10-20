-- 0071 SendGrid for company email: companies can connect SendGrid (their own key and sender)
-- as the alternative to Resend (src/integrations/sendgrid.js, providers.js).
ALTER TABLE integration_settings DROP CONSTRAINT integration_settings_provider_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_provider_check
  CHECK (provider IN ('stripe', 'resend', 'sendgrid', 'twilio', 'facebook', 'anthropic'));
