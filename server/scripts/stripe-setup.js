// Create (or refresh) Fishtape's products and prices on Fishtape's own Stripe account:
// one monthly CAD price per tier in electrical-app/js/plans.js plus the extra-user price, and
// the one-time $1.00 CAD sign-up deposit, matched by product id and price lookup key, so
// running it again changes nothing. The account is shared with other businesses: only
// fishtape_* products and lookup keys are ever created, changed or archived.
//
//   node scripts/stripe-setup.js --dry-run     show what would change
//   node scripts/stripe-setup.js               apply with a test key (sk_test_...)
//   node scripts/stripe-setup.js --live        required with a live key (sk_live_...)
//
// Reads STRIPE_SECRET_KEY from the environment or server/.env. Prints ids, never the key.
import Stripe from 'stripe';
import { loadEnvFile } from '../src/config.js';
import { ensureStripeCatalog } from '../src/services/billing.js';
import { ensureDepositPrice } from '../src/services/signup.js';

async function main() {
  loadEnvFile();
  const key = process.env.STRIPE_SECRET_KEY || '';
  const dryRun = process.argv.includes('--dry-run');
  if (!/^(sk|rk)_(test|live)_/.test(key)) {
    console.error('Set STRIPE_SECRET_KEY (Fishtape\'s own account, sk_test_... first).');
    process.exit(2);
  }
  if (key.includes('_live_') && !process.argv.includes('--live')) {
    console.error('This is a live key. Run again with --live if you mean it.');
    process.exit(2);
  }
  const stripe = new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: 'Fishtape setup' } });
  const log = (m) => console.log(`  ${m}`);
  const results = await ensureStripeCatalog(stripe, { dryRun, log });
  // Self-serve sign-up: the one-time $1.00 CAD deposit (fishtape_signup_deposit_cad).
  results.push(await ensureDepositPrice(stripe, { dryRun, log }));
  console.log(dryRun ? '\nDry run, nothing changed:' : '\nDone:');
  for (const r of results) console.log(`  ${r.key.padEnd(14)} ${r.action}${r.priceId ? ` ${r.priceId}` : ''}`);
  console.log('\nOnly fishtape_* products and lookup keys are created or changed; other products on the account are left alone.');
  console.log('\nNext: add a webhook endpoint for <PUBLIC_ORIGIN>/api/v1/webhooks/platform-stripe with events');
  console.log('  checkout.session.completed, checkout.session.expired, checkout.session.async_payment_succeeded,');
  console.log('  checkout.session.async_payment_failed, customer.subscription.created/updated/deleted, invoice.paid,');
  console.log('  invoice.payment_failed, invoice.upcoming; put its signing secret in STRIPE_WEBHOOK_SECRET.');
  console.log('  Turn on the customer portal (Settings > Billing > Customer portal) with these products.');
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
