# Take card payments on invoices with Stripe

When Stripe is connected, every invoice gets a **Pay online** link. Your customer pays by card on a Stripe page, the money goes to your Stripe account, and Fishtape records the payment on the invoice and marks it paid. The link is printed on the invoice and keeps working: it always asks for the balance owing at the time.

About 15 minutes. You need to be an owner or admin in Fishtape, and on the Pro plan or higher.

## What it costs

Fishtape adds nothing on top. Stripe charges per successful payment (Stripe Canada pricing, checked 2026-10-19):

| Payment | Stripe fee |
| --- | --- |
| Canadian card | 2.9% + $0.30 |
| Card issued outside Canada | add 0.8% |
| Currency conversion | add 2% |
| Monthly fee | none |

Example: a $1,050.00 invoice paid with a Canadian card costs $30.75 in Stripe fees. Check [stripe.com/en-ca/pricing](https://stripe.com/en-ca/pricing) for current rates.

## 1. Create or open your Stripe account

1. Go to [dashboard.stripe.com](https://dashboard.stripe.com) and sign in, or create an account.
2. Finish **Activate payments**: business details, your bank account for payouts, and identity checks. Until this is done you can only use test mode.

## 2. Make a restricted key for Fishtape

A restricted key can only do what Fishtape needs, which is safer than your full secret key.

1. In Stripe, open **Developers > API keys**.
2. Under **Restricted keys**, choose **Create restricted key**. Name it `Fishtape`.
3. Set **Checkout Sessions** to **Write**.
4. If you use QuickBooks with Fishtape, also set these to **Read**, so Fishtape can record each payment's Stripe fee and each payout to your bank (QuickBooks needs both to keep your books right): **PaymentIntents**, **Charges**, **Balance** (balance transactions; also **Balance transaction sources** if Stripe lists it) and **Payouts**. Leave everything else at **None**.
5. Create the key and copy it. It starts with `rk_live_`.
6. In Fishtape, open **Integrations > Stripe** and paste it into **Stripe secret key**.

Already made a key with only Checkout Sessions and now connecting QuickBooks? Edit it in Stripe and add the four **Read** permissions; the key itself stays the same. Fishtape asks Stripe again within a few hours for any fee or payout it could not read.

You can use a full secret key (`sk_live_…`) instead, but a restricted key limits the damage if it ever leaks.

## 3. Tell Stripe where to send payments

1. In Stripe, open **Developers > Webhooks** and choose **Add destination** (or **Add endpoint**).
2. Paste this endpoint URL (it is also on the Stripe card, with a Copy button):

   `{{webhook_url}}`

3. Select these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `payout.paid`, `payout.failed`, `payout.canceled` and `payout.updated` (your payouts to the bank, for QuickBooks)
4. Save. Open the new endpoint and choose **Reveal** under **Signing secret**. It starts with `whsec_`.
5. In Fishtape, paste it into **Stripe webhook signing secret** and press **Save**.

## 4. Test it

1. Press **Test connection** on the Stripe card. You should see "Connected (live mode)".
2. Open an invoice with a balance and press **Pay online**. Copy the link and open it: you should land on a Stripe payment page for the balance.
3. To try a real payment end to end, pay a small invoice to yourself, then refund it in Stripe.

Want to practise first? Use test keys (`rk_test_…` and a test-mode webhook secret) and Stripe's test card `4242 4242 4242 4242` with any future date and any CVC. Switch to live keys when you are ready.

## Good to know

- Payments recorded by Stripe show method **card** and the Stripe payment reference. Refunds are done in Stripe; record them on the invoice by hand for now.
- With QuickBooks connected, a minute or two after each payment Fishtape reads Stripe's fee for it. The payment goes to a "Stripe" bank account in QuickBooks at its full amount, the fee as an expense, and each payout as a transfer to your bank, so the books match your bank deposits.
- If you press **Pay online** again, you get the same link, so printed invoices keep working.
- Stripe retries a webhook for up to three days if Fishtape is unreachable, and Fishtape ignores repeats, so a payment is never recorded twice.
- Fishtape never sees card numbers. Stripe handles the card details.

> **Ask us to set this up.** We can connect Stripe for you, test it with a real payment and refund it, for a flat fee quoted up front. Included with Enterprise. [Email us](mailto:setup@fishtapehq.com?subject=Please%20set%20up%20Stripe) or press **Ask us to set this up** on the card.
