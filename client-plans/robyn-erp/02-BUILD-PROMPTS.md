# Build Prompts — Command Center

How to use:
1. Start a new repo. Paste **Prompt 0 (Master Context)** first in every new AI coding session (or save it as `CLAUDE.md` / `AGENTS.md` in the repo root so it loads automatically).
2. Run Prompts 1–7 in order, one per session/branch. Don't start the next until the acceptance checklist passes.
3. After each phase: deploy a preview, click through it on your phone, then move on.

---

## Prompt 0 — Master Context (save as CLAUDE.md)

```
You are building "Command Center", a multi-tenant business operating system (CRM + ERP) for a
Texas entrepreneur who runs four businesses at once:
  1. A real estate team (buyers + sellers, agents paid on commission splits)
  2. Apartment locating (a full-time locator; commissions are paid by apartment complexes after move-in)
  3. A mobile notary business covering Dallas–Fort Worth, scaling from "owner does every job"
     to "dispatching hired notaries who pay either a revenue share OR a monthly subscription for leads"
  4. A YouTube channel (content marketing)
She is also a full-time caregiver and homeschools two kids, so her available hours are
unpredictable. EVERY feature must work one-handed on a phone in under 30 seconds.

TECH STACK (do not substitute without asking):
- Next.js (App Router, latest stable) + TypeScript (strict), React Server Components + Server Actions
- Tailwind CSS + shadcn/ui, lucide icons, installable PWA (manifest + service worker), mobile-first
- Supabase: Postgres, Auth (email magic link + Google, optional TOTP 2FA), Row-Level Security,
  Storage, Realtime, pg_cron, Edge Functions
- Drizzle ORM (or Supabase generated types) + SQL migrations in /supabase/migrations
- Zod for every input; TanStack Query only where client caching is needed
- AI: Google Gemini API through a provider-agnostic interface in /lib/ai (models from env:
  AI_MODEL_FAST, AI_MODEL_SMART). Never hardcode a model name outside config.
- Twilio (SMS, voice, A2P 10DLC), Stripe + Stripe Connect, Google Calendar API,
  Google Maps (Distance Matrix, Places Autocomplete), Resend for email
- Hosting: Vercel. Testing: Vitest (unit), Playwright (e2e). Lint: ESLint + Prettier.

ARCHITECTURE RULES:
- Multi-tenant from day 1: every business table has org_id uuid not null + RLS policies keyed on
  the user's membership in that org. No query may bypass RLS except in server-only service code
  that is explicitly named *.service.ts.
- Roles: owner, admin, agent, locator, notary, assistant, accountant (read-only). Enforce in RLS AND UI.
- Every mutation goes through a typed "action" in /lib/actions/<domain>.ts that: validates with Zod,
  checks permission, writes, and appends to an append-only `events` table
  (org_id, actor_id, entity_type, entity_id, type, payload jsonb, created_at). This event log is
  the audit trail and the AI's memory.
- The same actions must be exposable later as API routes and MCP tools — keep them pure and typed.
- Money in integer cents. Timestamps in UTC (timestamptz); display in America/Chicago.
- Sensitive notary ID fields are encrypted at rest (pgsodium / Supabase Vault or app-level AES-GCM).
- Webhooks (Stripe, Twilio) verify signatures and are idempotent (store processed event ids).
- Feature flags per org in `org_settings` so modules can be turned on/off.
- Compliance guardrails: TCPA (consent logged, STOP/HELP handling, quiet hours 9pm–8am local),
  Fair Housing (AI must never filter or steer by protected class), CAN-SPAM unsubscribe,
  Texas notary journal requirements (make statutory fee caps configurable; do not hardcode legal values).

UX RULES:
- Bottom tab nav on mobile (Today, Pipelines, Inbox, Calendar, More); sidebar on desktop.
- A global "+" quick-add (lead, job, task, note) with voice dictation (Web Speech API).
- Empty states teach the user what to do. Skeleton loaders, optimistic updates, toasts.
- Accessible (WCAG AA), dark mode, large tap targets.

WORKING STYLE:
- Before coding each phase, print a short plan (files, tables, routes). Then implement.
- Write migrations, seed data, unit tests for business logic (fees, commissions, permissions),
  and one Playwright happy-path test per phase.
- Keep a running /docs/CHANGELOG.md and /docs/ARCHITECTURE.md.
- If something is ambiguous, choose the simplest option that keeps multi-tenancy and the
  action/event pattern intact, and note the assumption in the changelog.
```

---

## Prompt 1 — Foundation

```
Phase 1: Foundation. Using the Master Context:

1. Scaffold the Next.js + Supabase app, Tailwind, shadcn/ui, PWA manifest + service worker,
   dark mode, mobile bottom nav + desktop sidebar shell.
2. Auth: magic link + Google sign-in, optional TOTP 2FA, invite users by email to an org with a role.
3. Tables + RLS: orgs, org_members(role), org_settings(feature flags, branding, timezone,
   business hours), profiles, events (append-only), files (Supabase Storage refs), notes, tasks.
4. Build /lib/actions pattern with a helper `defineAction({ input: zodSchema, permission, run })`
   that validates, authorizes, executes in a transaction, and writes an event.
5. Build /lib/ai with a provider interface: generateText, generateJSON(schema), embed,
   streamChat(tools). Implement the Gemini provider. Add per-org AI usage + cost logging table
   (ai_usage: model, tokens_in, tokens_out, cost_cents, feature).
6. Global quick-add sheet (lead / task / note) with voice dictation; AI turns a dictated sentence
   into a structured record (e.g., "New buyer Maria, 300k in Frisco, call Friday" → contact + task).
7. Settings pages: org profile, branding (logo/colors), team members & roles, feature toggles.
8. "Export everything" button (zip of CSV per table) and nightly backup job note in docs.

Acceptance:
- Two orgs seeded; a user in org A cannot read org B data (prove with a test).
- A notary-role user cannot see Settings or other users' leads.
- Quick-add by voice creates a contact + task and writes events.
- Lighthouse PWA installable on iPhone Safari.
```

---

## Prompt 2 — Unified CRM + Pipelines

```
Phase 2: CRM. Using the Master Context:

DATA
- contacts (person or company; names, phones[], emails[], address, source, tags[], lead_score,
  owner_id, consent_sms, consent_email, consent_logged_at, dnc boolean, birthday, notes)
- companies (title companies, lenders, apartment complexes, hospice agencies, law firms, etc.,
  with type enum) and contact_companies
- pipelines (org-defined, with business_line enum: real_estate_buyer, real_estate_seller,
  apartment_locating, notary, b2b_account, recruiting) and pipeline_stages (ordered, win/lose flags,
  probability)
- deals (contact_id, pipeline_id, stage_id, value_cents, expected_close, assignee_id, custom jsonb)
- activities (call, sms, email, meeting, showing, note) linked to contact/deal
- Seed default pipelines + stages:
  Buyers: New → Contacted → Pre-approved → Showing → Under Contract → Closed / Lost
  Sellers: New → Listing Appt → Listing Signed → Active → Under Contract → Closed / Lost
  Apartment Locating: New → Criteria Gathered → Options Sent → Touring → Applied → Approved →
    Moved In → Commission Invoiced → Paid / Lost   (custom fields: budget, move date, beds,
    areas, pets, credit/eviction notes, lease_end_date, complex_id)
  Notary Jobs: Request → Quoted → Booked → Assigned → Completed → Paid / Cancelled
  B2B Accounts: Prospect → Intro → Trial Job → Active Account → Dormant
  Recruiting: Applied → Screen → Docs Verified → Onboarding → Active

UI
- "Today" screen: overdue follow-ups, today's appointments, new leads, hot leads (score), money
  waiting to be collected. Swipe actions: call, text, snooze, done.
- Kanban per pipeline (drag between stages, mobile-friendly long-press), list view with filters,
  saved views.
- Contact 360 page: timeline of all events/activities across ALL business lines, deals in every
  pipeline, files, tasks, consent status, "AI summary" card.
- Duplicate detection + merge (phone/email match).
- Lead capture: embeddable form builder per pipeline (public URL + iframe snippet), UTM capture,
  auto-assign rules (round robin or by area/zip), and an inbound email parser endpoint for
  forwarded lead emails (use AI generateJSON to extract name/phone/email/intent).
- CSV import wizard with column mapping + a "Follow Up Boss export" preset.

CROSS-SELL AUTOMATIONS (rules engine stored as rows, evaluated on events):
- Deal Closed in Buyers/Sellers → create notary-offer task + tag "past client".
- Apartment deal Moved In → create Buyers nurture deal ("future buyer") and a task 60 days before
  lease_end_date for renewal/relocation.
- Notary job Completed → ask "Thinking of buying/selling/renting?" in post-job message, tag signer.

Acceptance:
- Create a lead via public form → appears in correct pipeline, assigned, event logged.
- Moving an apartment deal to Moved In creates the future-buyer deal and lease-renewal task.
- FUB CSV sample imports with mapping and dedupe.
- Unit tests for rules engine and dedupe.
```

---

## Prompt 3 — Notary Booking, Travel Fees, Dispatch & Journal

```
Phase 3: Notary operations. Using the Master Context:

DATA
- notary_services (name, base_fee_cents, per_signature_fee_cents, duration_min, requires_loan_pkg)
- travel_fee_rules (mode: zones | per_mile; zones as polygons or radius from home base; per-mile
  rate; minimum; after-hours %/flat; rush flat; waiting-time per 15 min)
- availability: weekly hours + "protected blocks" (recurring or one-off, private label, e.g.
  caregiving/homeschool) + Google Calendar busy times
- notary_profiles (user_id, commission # + expiry, bond expiry, E&O expiry, loan-signing certified,
  service radius, home base lat/lng, rating, lead_model enum: revenue_share | subscription,
  revenue_share_pct, subscription_tier_id, active)
- notary_jobs (deal_id, contact_id, service_id, signers count, location (Places), scheduled_at,
  quote breakdown jsonb, status, assigned_notary_id, dispatch_log jsonb, payment status)
- journal_entries (job_id, notary_id, date/time, type of act, document description, signer name,
  signer address, ID type + issuer + number (ENCRYPTED) + expiry, or credible witness info,
  fee charged, signature image, thumbprint optional, notes). Owner/admin + that notary only.

FEATURES
- Public booking page (/book/[org]): pick service → address autocomplete → live quote
  (Distance Matrix from nearest available notary or home base) → pick open slot → pay deposit
  via Stripe Checkout or "pay on site" → confirmation SMS/email + .ics.
- Slot engine respects protected blocks + Google Calendar busy + drive time between jobs.
  When the owner is unavailable but a hired notary is, offer the slot anyway and route to dispatch.
- Dispatch board (desktop table + mobile cards): auto-offer to eligible notaries by distance,
  tier priority (subscription Elite > Pro > Basic > revenue share), rating, credential validity.
  Offer via SMS + push with accept link; first-accept wins; timeout escalates to next notary,
  then to owner.
- Notary mobile job view: map/navigate button, checklist, "On my way" (texts signer ETA),
  "Arrived", journal entry form with signature capture, photo upload of scanbacks, "Complete".
- On Complete: generate invoice (Stripe), calculate payout per lead model, request Google review,
  trigger cross-sell message.
- Credential expiry alerts 30/7 days before (commission, bond, E&O); expired notaries cannot be
  dispatched.
- Mileage log auto-created per job (for taxes).

Acceptance:
- Quote math covered by unit tests (zones, per-mile, after-hours, rush, minimums).
- Booking cannot land on a protected block.
- Dispatch skips a notary with an expired commission.
- Journal ID numbers are unreadable in the raw DB row.
- E2E: book → dispatch → accept → complete → invoice paid (Stripe test mode).
```

---

## Prompt 4 — AI Assistant, Messaging & Follow-ups

```
Phase 4: Communications + AI. Using the Master Context:

MESSAGING
- Twilio: buy/attach numbers per org, inbound/outbound SMS + MMS, call forwarding with
  call logging + recording (with consent prompt), voicemail transcription.
- Unified Inbox: SMS, email (Resend inbound or Gmail API), web chat — threaded per contact,
  assignable, snooze, templates, AI "draft reply" button.
- Compliance: STOP/START/HELP keywords, quiet hours queue, consent required for marketing SMS,
  A2P 10DLC registration checklist page.

AUTOMATIONS
- Sequence builder (steps: wait, SMS, email, task, AI-SMS, branch on reply/stage/tag) attachable
  to pipeline stages. Auto-stop on reply, on stage change, on opt-out.
- Ship default sequences: new buyer, new seller, apartment seeker, notary quote follow-up,
  past-client nurture (quarterly), B2B title-company outreach, lease-renewal.
- Missed-call text-back: on unanswered call → SMS "Sorry I missed you! Are you looking for a
  notary, a home, or an apartment?" → AI qualifies via conversation and books or creates a deal.

AI (via /lib/ai, Gemini)
- Speed-to-lead: new lead → AI drafts first reply within 60s using pipeline playbook.
  Per-pipeline mode: "draft for approval" (default) or "auto-send".
- Website chat widget (embeddable script) with tool-calling: get_quote, list_open_slots,
  book_notary_job, create_lead, handoff_to_human. Strict Fair Housing guardrail system prompt and
  a post-generation check; never discuss protected classes or steer.
- In-app assistant (chat sheet) with tools mapped to the typed actions: search contacts, summarize
  contact, create task, move deal, draft message, what's on my schedule, revenue this month.
  All tool calls are logged as events with actor "ai".
- Daily Brief: pg_cron at 7:00 America/Chicago → push + SMS to owner: today's jobs, hot leads,
  overdue follow-ups, money owed, one suggested "10-minute win".
- Contact AI summary card refreshed on new activity (cache, cheap model).
- AI cost guard: monthly budget per org; when 80% used, notify; at 100%, fall back to drafts only.

Acceptance:
- STOP immediately blocks all future SMS to that number (test).
- Missed call in Twilio test → text-back sent → simulated replies end in a booked job.
- Chat widget cannot be prompted into steering by a protected class (include red-team tests).
- Daily Brief renders correctly with seeded data.
```

---

## Prompt 5 — Team, Commissions, Notary Subscriptions & Money

```
Phase 5: Team + money. Using the Master Context:

- commission_plans: type (agent_split, locator_split, notary_revenue_share), split %, caps,
  team fee, transaction fee, tiered splits after cap. Assign plans to members.
- Real estate: on Closed, compute gross commission → team/agent split → net; store a
  commission statement (PDF) per deal.
- Apartment locating: on Moved In, create a receivable invoice to the complex
  (company_id, amount, due date), track Invoiced → Paid, then pay locator split.
- Notary lead model (per notary):
  * revenue_share: payout = job total − org % (configurable), paid via Stripe Connect Express
    transfers (weekly batch).
  * subscription: Stripe Billing products/tiers (e.g., Basic/Pro/Elite) with monthly lead quota,
    service radius, dispatch priority. Notary self-serve signup + Connect onboarding + billing
    portal. Quota resets monthly; overage rule configurable.
- Recruiting portal: public "Join our notary team" page → Recruiting pipeline → credential
  uploads → onboarding checklist → activate.
- Dashboards:
  * Owner: revenue by business line, pipeline value, commissions owed to/by her,
    notary subscription MRR + churn, receivables from complexes, Stripe balance, AI/Twilio spend.
  * Agent/Locator/Notary: my deals, my earnings, my jobs, leaderboard.
- Expenses: photo receipt → AI extracts vendor/amount/category; mileage from jobs; CSV export
  for accountant role (QuickBooks-friendly).

Acceptance:
- Unit tests for every commission plan type including caps.
- Subscription notary over quota is not offered new leads (unless overage enabled).
- Stripe Connect test payouts reconcile with job totals.
```

---

## Prompt 6 — Content Studio, Personal Command Center & Growth

```
Phase 6. Using the Master Context:

CONTENT STUDIO
- content_ideas auto-mined weekly from inbound messages/chat transcripts (AI clusters the most
  common questions by business line) + manual ideas.
- Idea → AI outline/script in the owner's voice (store a "voice profile" from samples she pastes),
  3 title options, thumbnail text, description with booking/landing links, chapters.
- Content calendar (Kanban: Idea → Scripted → Recorded → Edited → Published) with small weekly
  batch goals. Repurpose button: shorts list, social captions, newsletter blurb (copy/export for
  her newsletter tool), SEO blog draft.
- Optional: YouTube Data API read-only stats per published video.

PERSONAL COMMAND CENTER (owner-only, private)
- Unified calendar (Google two-way sync) layering business, caregiving, homeschool.
- Protected blocks UI (feeds the booking engine).
- Tasks with energy (low/med/high) + minutes; "I have 15 minutes" button shows best-fit tasks.
- Private caregiving notes and reminders (never visible to team, never sent to AI unless she
  explicitly opts in).

GROWTH
- Programmatic landing pages: service × DFW city (Dallas, Fort Worth, Plano, Frisco, Arlington,
  McKinney, Irving, Garland, Denton, Grand Prairie, etc.), editable templates, schema.org
  LocalBusiness markup, forms wired to pipelines, sitemap.
- Review engine: after job/closing, SMS review request with link to Google Business Profile;
  private feedback path for <4 stars.
- Referral partners: companies of type title/lender/complex/hospice with "last touched" and
  touch cadence reminders; referral attribution on deals.
- Lead source ROI report: cost (manual entry) vs closed revenue by source.

Acceptance:
- Landing pages pass Lighthouse SEO ≥ 95.
- Caregiving notes are excluded from AI context and team queries (test).
```

---

## Prompt 7 — Polish, Demo Data, MCP & Handoff

```
Phase 7. Using the Master Context:

1. Demo seed for a sales demo: realistic DFW data — 60 contacts across all pipelines, 4 agents,
   1 locator, 3 notaries (one rev-share, two subscription tiers), 25 notary jobs, 10 apartment
   deals, 5 complexes, 3 title companies, sequences running, inbox threads, a filled Today screen
   and dashboards. Clearly fake names/phones (555 numbers). One-click "Reset demo".
2. Onboarding wizard for a new org: business lines on/off, brand, phone number, Stripe connect,
   Google connect, import contacts, notary pricing, done.
3. MCP server (/api/mcp) exposing the typed actions as tools with per-user API tokens + scopes,
   so any AI assistant (Gemini, Claude, ChatGPT, Grok) can operate the system safely.
   Public REST API + outbound webhooks (deal.stage_changed, job.completed, lead.created).
4. Performance pass (indexes on org_id + foreign keys, pagination), security pass (RLS audit
   script that tries cross-org reads on every table), accessibility pass.
5. White-label: custom domain per org, logo/colors, email/SMS sender names — so the owner can
   resell this to the notaries she recruits.
6. Docs: owner user guide (short, screenshots), admin runbook, env var list, cost table.

Acceptance:
- Fresh org can go from signup to first booked job in < 15 minutes via wizard.
- RLS audit script passes on all tables.
- MCP tool call "create lead" works from an external client with a scoped token.
```

---

## Bonus — Message to send Robyn (she asked for examples to choose from)

```
Hey Robyn! Here's a menu to make it easy — just tell me which ones you want first
(or say "all of it" 😄):

🏠 One CRM for everything — buyers, sellers, apartment seekers, and notary clients in one
   place, with your Follow Up Boss contacts imported.
📅 Notary booking page — clients book online, travel fee calculated automatically across DFW,
   and it never books over your time with your mom or the kids.
🚗 Notary dispatch — when you're busy, jobs go to notaries you hire. They either pay you a %
   per job or a monthly subscription — you pick per notary.
🤖 AI follow-up — every new lead gets a text in under a minute, missed calls get an automatic
   text back, and a chat bot on your site books appointments 24/7.
☀️ Morning brief — a text every morning: today's appointments, hot leads, and who owes you money.
💰 Commissions — agent splits, locator commissions from complexes, and notary payouts tracked
   automatically.
🎥 YouTube helper — turns the questions your leads actually ask into video ideas and scripts.
📈 Lead machine — "Mobile notary Frisco"-type pages for every DFW city + automatic review requests.

It runs on Gemini so AI costs stay near zero, and there's no big GHL-style setup fee.
Which 2–3 would make the biggest difference for you right now?
```
