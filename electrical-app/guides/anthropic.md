# Connect Claude (Anthropic) for the AI assistant

Fishtape's assistant drafts estimates and invoices for you to approve, answers Canadian Electrical Code questions using the built-in calculators, and runs background helpers. It uses your company's own Anthropic API key, so usage is billed to your Anthropic account and your data stays under your agreement with Anthropic.

About 10 minutes. You need to be an owner or admin in Fishtape, on the Business plan.

## What it costs

Anthropic charges per token (roughly, per word read and written). Prices per million tokens, checked 2026-10-19, in US dollars:

| Model | Input | Output |
| --- | --- | --- |
| Claude Opus 5.5 | $4 | $20 |
| Claude Sonnet 5.5 | $2 | $10 |
| Claude Haiku 5.5 | $0.10 | $0.50 |

A typical estimate draft reads and writes a few thousand tokens, which is a few cents. Check [claude.com/pricing](https://claude.com/pricing) for current prices. Set a monthly spend limit in the Console (step 2) so there are no surprises.

## 1. Create an Anthropic account

1. Go to [platform.claude.com](https://platform.claude.com) and sign up with your work email.
2. Create or pick the organization for your company.

## 2. Add billing and a spend limit

1. Open **Settings > Billing** and add a payment method.
2. Open **Settings > Limits** and set a monthly spend limit you are comfortable with, for example $50.

## 3. Create an API key

1. Open **Settings > API keys > Create key**. Name it `Fishtape`.
2. Copy the key. It starts with `sk-ant-` and is shown once.
3. In Fishtape, open **Integrations > Anthropic (Claude)**, paste it and press **Save**.
4. Fishtape checks the key with a free call that lists the available models. You should see "Connected."

## Good to know

- You can see usage per day and per model in the Console under **Usage**.
- If you ever think the key leaked, delete it in the Console, create a new one and paste it here. The old one stops working at once.
- Disconnecting here deletes the key from Fishtape; the AI features stop until a key is added again.

> **Ask us to set this up.** We can set up the account, billing limits and key with you, and show your team how to use the assistant, for a flat fee quoted up front. Included with Enterprise. [Email us](mailto:setup@fishtapehq.com?subject=Please%20set%20up%20Claude) or press **Ask us to set this up** on the card.
