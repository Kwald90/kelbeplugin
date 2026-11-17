# "Command Center" — Business Operating System for Robyn

Working name: **Command Center** (rename in branding later).

## 1. Who she is and what's actually broken

| Business line | Today | Pain |
|---|---|---|
| Real estate team (Texas) | Follow Up Boss, agents to pay | Slow market, needs leads, can't afford GHL setup fees |
| Apartment locating (1 full-time locator) | Ad hoc | New lead type, commissions come from complexes |
| Mobile notary (most of DFW) | She does every job herself | Wants to hire notaries and sell them leads (% or subscription) |
| YouTube channel | Behind on content | No time |
| Newsletter | Instinct (automated) | Works — keep it, integrate later |
| Life | Full-time caregiver (mom + stepdad), homeschools 2 kids | Her available hours are unpredictable |

**Root problem:** everything runs in her head and across too many AI tools. She doesn't need more tools — she needs **one place** that knows her businesses, her schedule, and does the follow-up for her.

**Design rule for every screen:** usable from a phone, one-handed, in 30 seconds, while sitting in a hospice visit.

## 2. Stack (standalone web app, budget-first)

| Layer | Choice | Why |
|---|---|---|
| App | Next.js (App Router) + TypeScript, installable **PWA** | One codebase for phone + desktop, no app-store fees |
| UI | Tailwind + shadcn/ui | Fast, clean, accessible |
| DB/Auth/Files | **Supabase** (Postgres, Auth, Row-Level Security, Storage, Realtime, pg_cron) | Free/cheap tier, real SQL, multi-tenant ready |
| Background jobs | Supabase pg_cron + Edge Functions (or Inngest) | Drips, reminders, sync jobs |
| AI | **Gemini API** (latest Flash model for volume, Pro for heavy tasks; model names in env vars) | Cheapest, free tier, as promised to her |
| SMS/Voice | Twilio (A2P 10DLC registered) | Texting, call tracking, missed-call text-back, AI receptionist |
| Payments | **Stripe** + **Stripe Connect** | Invoices, deposits, notary subscriptions, notary payouts |
| Calendar/Maps | Google Calendar API, Google Maps (Distance Matrix, Places) | Scheduling, DFW travel fees, drive time |
| Email | Resend (or Gmail API) | Transactional + drip email |
| Hosting | Vercel + Supabase | ~$0–45/mo to start |

**Estimated running cost at launch:** roughly $25–75/mo + Twilio usage + Stripe fees. (Versus GHL's setup cost she called "insane.")

## 3. Modules

Legend: ⭐ = she asked for it · 💡 = she didn't mention it but needs it ("Kelvinized" extras)

### M1. Unified CRM + Pipelines ⭐
- One contact record, many relationships (a renter today can be a buyer in 18 months and a notary customer tomorrow).
- Separate pipelines with their own stages:
  - **Buyers** (New → Contacted → Pre-approved → Showing → Under contract → Closed)
  - **Sellers** (New → Appointment → Listing signed → Active → Under contract → Closed)
  - **Apartment locating** (New → Criteria gathered → Tours sent → Applied → Approved → Moved in → Commission invoiced → Paid)
  - **Notary jobs** (Request → Quoted → Booked → Assigned → Completed → Paid)
  - **B2B notary accounts** 💡 (title companies, lenders, signing services, law firms, hospitals/hospice, senior living)
- Kanban + list + "Today" view. Tags, sources, lead score, owner/assignee.
- Lead capture: web forms, landing pages, SMS, missed calls, CSV import, email-forward parsing (Zillow/Realtor/Apartment-lead emails), manual "quick add" by voice.
- 💡 **Cross-sell engine:** every closed real estate deal → offer notary services; every notary signer → tagged as possible buyer/seller/renter; every apartment move-in → "future buyer" nurture + lease-renewal reminder 60 days before lease end (repeat locator commission).
- 💡 **Follow Up Boss migration** button (CSV import now, API later) so she can leave FUB when ready.

### M2. Notary Booking + Dispatch ⭐
- Public booking page (mobile notary, loan signing, RON referral, hospital/jail/hospice visits, after-hours).
- 💡 **DFW travel-fee calculator** via Google Maps: zones or per-mile, after-hours/rush surcharges, auto quote.
- 💡 **Availability that respects caregiving:** she sets "protected blocks" (hospice visits, homeschool, family); booking only offers open slots; overflow jobs auto-route to hired notaries.
- Dispatch board: job → offer to notaries by distance/rating/tier → accept from phone (first-accept or round-robin).
- Notary mobile view: job details, map link, document checklist, ID check notes, "arrived/complete" buttons, signer signature capture.
- 💡 **Texas-compliant electronic notary journal** (fields required by Texas rules; ID info encrypted; retention + export). Statutory fee caps configurable — verify current Texas Gov't Code / SOS rules before launch.
- Invoices + deposits via Stripe; automatic receipt + review request after completion.
- 💡 Commission/notary-bond/E&O expiry tracking for every notary she hires.

### M3. AI Assistant + Follow-ups ⭐
- **Gemini-powered assistant** inside the app ("What should I do today?", "Draft a reply to this lead", "Who haven't I talked to in 30 days?").
- AI lead replies within 60 seconds by SMS/email (approve-first mode or auto mode per pipeline).
- Drip sequences (SMS + email) per pipeline with smart stop on reply.
- 💡 **Missed-call text-back** ("Sorry I missed you — are you looking for a notary, a home, or an apartment?") → AI qualifies and books.
- 💡 **24/7 website chat widget** that books notary jobs and captures RE/locating leads.
- 💡 **AI voice receptionist** (Phase 2) for after-hours calls.
- 💡 **Daily Brief** (7am text/push): today's appointments, hot leads, overdue follow-ups, money owed to her.
- 💡 Fair-housing/TCPA guardrails: AI never steers by protected class; opt-out handling (STOP), quiet hours, consent logging.

### M4. Team, Commissions + Notary Network ⭐
- Roles: Owner, Admin, Agent, Apartment Locator, Notary (contractor), Assistant/VA, Read-only accountant.
- Commission plans: agent splits, caps, team fees; locator splits; complex-paid locator commissions tracked as receivables 💡.
- **Notary lead model — both options:**
  - **Revenue share:** she keeps X% per job; system calculates payout.
  - **Subscription tiers:** e.g., Basic/Pro/Elite monthly via Stripe, each with lead quotas, priority dispatch, service radius.
  - Per-notary setting chooses the model; Stripe Connect handles payouts.
- Leaderboard + production dashboard (gentle accountability for a slow market).
- 💡 Recruiting pipeline for hiring notaries/agents (application form → background/commission check → onboarding checklist).

### M5. Content Studio (YouTube) ⭐
- Idea bank auto-filled from **real questions leads ask** (pulled from SMS/chat transcripts).
- AI script/outline drafts in her voice, title + thumbnail-text ideas, description with links to booking pages.
- Content calendar with tiny batches ("record 3 shorts this week") that fit around caregiving.
- Repurpose: one video → shorts list, newsletter blurb (hand to Instinct), social captions, blog/SEO page.

### M6. Personal Command Center 💡
- One calendar: business + caregiving + homeschool (Google Calendar sync).
- Tasks with "energy level" and "time needed" so she can grab a 10-minute task between visits.
- Caregiving notes (hospice visit days, meds reminders) — private, owner-only.

### M7. Money Dashboard 💡
- Revenue by business line, pipeline value, commissions owed (to her and by her), notary subscription MRR, Stripe payouts, mileage log (Maps) for taxes, expense capture by photo.
- Monthly AI spend tracker (Gemini/Twilio) so she never gets a surprise bill.

### M8. Growth Engine 💡
- SEO landing pages per service × DFW city ("Mobile notary Frisco", "Apartment locator Arlington") generated from templates.
- Google Business Profile review requests after each job/closing.
- Referral partner tracking (title companies, lenders, complexes, hospice agencies) with "last touched" reminders.
- Lead source ROI report (where did paying customers actually come from).

## 4. "2029-ready" foundations (built in from day 1)
1. **Multi-tenant architecture** (every row has `org_id` + RLS). Today it's Robyn's; tomorrow you can sell the same system to other notaries/agents — and so can she, as a white-label to the notaries she recruits.
2. **AI-agent-ready API**: every action (create lead, book job, send SMS) is a typed server action + an **MCP server** endpoint, so any assistant (Gemini, Claude, Grok, ChatGPT) can operate the system. Ends the "too many AIs" problem — the AI choice becomes swappable.
3. **Model-agnostic AI layer**: one `ai/` provider interface; Gemini default, swap via env var.
4. **Event log / audit trail** on every record (compliance + AI memory).
5. **Voice-first input** (dictate notes/leads) and offline-tolerant PWA.
6. **Data ownership**: one-click full export (CSV/JSON), nightly backups.
7. **Security**: 2FA, field-level encryption for notary ID data, least-privilege roles, signed webhooks.
8. **Integrations hub**: webhooks in/out + Zapier/n8n compatibility so future tools plug in without a rebuild.

## 5. Phased roadmap

| Phase | Ships | Goal |
|---|---|---|
| 0 — Foundation | Auth, orgs, roles, design system, PWA, audit log, AI layer | Skeleton you reuse for every client |
| 1 — CRM | Contacts, pipelines, Today view, import, forms | Demo #1 to Robyn |
| 2 — Notary | Booking, travel fees, dispatch, journal, Stripe invoices | Revenue now |
| 3 — AI + Comms | Twilio, drips, AI replies, missed-call text-back, chat widget, Daily Brief | "It works while I'm with mom" |
| 4 — Team + Money | Commissions, notary subscriptions/rev-share, Stripe Connect, dashboards | Scale beyond herself |
| 5 — Content + Personal + Growth | Content studio, personal calendar, SEO pages, reviews | Long-term leads |
| 6 — Polish | Seed demo data, onboarding wizard, MCP server, export, docs | Hand-off + resell |

The prompts in `02-BUILD-PROMPTS.md` map 1:1 to these phases.

## 6. Open questions to confirm with Robyn
1. Brokerage name / does her brokerage restrict tools or require TREC-specific disclosures on her forms (IABS link in footer)?
2. Notary pricing: current fees, travel zones, after-hours rules; does she do loan signings / RON?
3. How many agents, locators, notaries today, and target in 12 months?
4. Locator: which complexes/locating networks does she work with and how are commissions paid?
5. Phone number: keep her existing number (port to Twilio) or new tracking numbers?
6. Must-keep tools: Instinct (newsletter), Follow Up Boss (for now) — anything else?
7. Domain + branding (logo, colors).
8. Should AI reply automatically or always draft for her approval at first?
