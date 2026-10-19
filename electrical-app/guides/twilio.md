# Send texts from your own number with Twilio

With Twilio connected, Fishtape sends the text steps of your follow-up sequences from your own phone number. Customers who reply **STOP** are never texted again (until they reply **START**). Without it, texts wait in the outbox for someone to send by hand.

About 20 minutes. You need to be an owner or admin in Fishtape, on the Business plan.

## What it costs

Twilio pricing for Canada, checked 2026-10-19 (Twilio bills in US dollars):

| Item | Price |
| --- | --- |
| Canadian local phone number | $1.15 a month |
| Text sent or received | $0.0083 per segment (a segment is up to 160 plain characters) |
| Carrier fees | about $0.006 to $0.03 per text, depending on the carrier |

Example: 300 follow-up texts a month cost roughly $1.15 + $2.49 + carrier fees, about $6 to $10. Check [twilio.com/en-us/sms/pricing/ca](https://www.twilio.com/en-us/sms/pricing/ca) for current prices.

## 1. Create a Twilio account and upgrade it

1. Sign up at [twilio.com](https://www.twilio.com/try-twilio).
2. A new account is a trial: it can only text numbers you have verified, and every text starts with a trial notice. Before using it with customers, press **Upgrade** and add a payment method.

## 2. Buy a local number

1. In the Twilio Console, open **Phone Numbers > Manage > Buy a number**.
2. Country **Canada**, tick **SMS**, and search by your area code (for example 403 or 587).
3. Buy the number. It is yours for as long as you pay the monthly fee.

## 3. Copy your account details

1. On the Twilio Console home page, find **Account Info**.
2. Copy the **Account SID** (starts with `AC`) and the **Auth Token** (press **Show** first).
3. In Fishtape, open **Integrations > Twilio** and paste them, plus your new number in **Twilio sending number** (any format, for example `(403) 555-0100`).
4. Press **Save**. Fishtape tests the connection and checks the number belongs to the account.

## 4. Send STOP replies to Fishtape

Twilio already blocks texts to anyone who replied STOP. This step lets Fishtape see those replies too, so it marks the outbox item instead of trying.

1. In Twilio, open **Phone Numbers > Manage > Active numbers** and pick your number.
2. Under **Messaging configuration**, set **A message comes in** to **Webhook**, method **HTTP POST**, with this URL:

   `{{webhook_url}}`

3. Save.

## 5. Try it

1. Make a sequence with a text step on day 0, and enrol a test lead with your own mobile number.
2. The text arrives within a minute, ending with "Reply STOP to opt out."
3. Reply **STOP**. The next text to your number is marked failed with "This person replied STOP". Reply **START** to undo it.

## Good to know

- Numbers are converted to the international format Twilio needs (`+14035550100`). A number that can't be a valid Canadian or US number fails with a clear message on the outbox item.
- Follow-up texts end with "Reply STOP to opt out." unless the message already mentions STOP. Canada's anti-spam law (CASL) requires an unsubscribe option in marketing messages, and you need the customer's consent (for example, they asked you for a quote) before texting them.
- Texting US numbers from a Canadian number may need extra registration in Twilio (A2P 10DLC). Ask us if you text US customers.

> **Ask us to set this up.** We can pick and buy a local number with you, connect it and test STOP handling, for a flat fee quoted up front. Included with Enterprise. [Email us](mailto:setup@fishtapehq.com?subject=Please%20set%20up%20Twilio%20texts) or press **Ask us to set this up** on the card.
