# Onboard a tenant (a new electrical company)

While self-serve signup is closed, Kelvin creates each company. TG Electrical is tenant #1.

## 1. Before creating anything

- Agreement in place: terms of service, privacy notice, and the data processing terms (Fishtape
  processes the company's customer data on its behalf; see [privacy.md](../compliance/privacy.md)).
- Plan chosen (tier, trial or paid) and billing contact.
- Province recorded (it drives tax and the code book: CEC with provincial amendments).
- The owner's email address, confirmed by phone or in person (not just by an inbound email).
- Quebec companies: not yet (needs Law 25 work, French, Chapter V).

## 2. Create the company and its owner

On the host, as a one-off container with the app role (no BYPASSRLS):

```bash
cd <checkout>/deploy/<env>
sudo docker compose run --rm --no-deps api npm run --silent tenant:create -- \
  --name "Sparky Electric Ltd" --email owner@sparkyelectric.ca --owner "Pat Owner" --province ON
```

It prints the company id and a generated password **once**. Send the password through a separate
channel from the email address (text it, or read it out); never email both together. The owner
must set up two-step sign-in (TOTP) at first sign-in.

## 3. Set up the company with the owner

- Owner signs in, enrols MFA, changes the password, fills in Settings (company details, province,
  tax, units, code book).
- Members: owner invites admins, office staff and crew (each admin gets MFA too).
- Shared iPads: a manager registers each device; crew get name + PIN on it.
- Integrations the company wants (Stripe, Twilio, Resend, Facebook Lead Ads, Anthropic for AI):
  the company creates its own accounts and keys and enters them in Settings using the in-app
  guides. Fishtape never asks for these keys by email or phone; if setup is sold as a service,
  do it on a screen share with the owner typing the keys.
- Plan entitlements: set the plan in HQ (trial end date if a trial).

## 4. Check

- HQ, Tenants: the company is listed, status active, member count right.
- Sign in as the owner on a fresh browser: MFA prompt appears; data from other companies is not
  visible (spot-check one list).
- `/api/v1/status` fine; nothing new in HQ error counts.

## Record

- The audit chain records the creation (actor `tenant:create`).
- Keep the signed agreement, plan and onboarding date in the customer records (not in git).
- Add the owner and a second contact to the list used for incident notices to tenants.
