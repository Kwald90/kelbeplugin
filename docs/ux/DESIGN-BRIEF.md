# Design brief: clarity from quote to payment

## Assessment

Fishtape already has a consistent warm visual identity and useful electrical
features: plan takeoff, work planning, materials, time, job costing, and invoicing.
The opportunity is to connect this capability through understandable tasks.

| Evidence reviewed | Friction or strength | Direction |
| --- | --- | --- |
| `js/app.js`, `css/app.css`, saved phone and desktop screenshots | Long icon-only navigation; mobile labels hidden | Labelled destinations, role-relevant mobile shortcuts, complete More menu |
| `js/modules/dashboard.js` | Useful attention list appears after several other sections | Put actionable exceptions and today's work first |
| `js/modules/estimates.js`, saved estimate screenshot | Pricing configuration leads the editor; staff can mark a document Accepted | Lead with customer and work, disclose advanced pricing, call the staff action Record approval |
| `js/modules/jobs.js` | Existing tabs already connect most job information | Evolve the job overview instead of rebuilding separate records |
| `js/modules/today.js`, saved phone screenshot | Large task buttons, progress, photos, blocked reasons, local save feedback | Preserve these; clarify task progress versus payroll time |
| `js/modules/onboarding.js` | Approximately ten setup steps | Introduce setup when needed to complete the first useful job |
| `index.html`, `css/app.css` | Disabled zoom request; small secondary buttons | Allow zoom and improve touch hit regions; test larger text |
| `server/src/routes/v1/integrations.js` | Existing document email and invoice payment links | Reuse existing services for the future customer journey |

These are code and screenshot observations, not measured customer behaviour.

## Experience rules

1. A screen has a clear title, current state, and primary next action.
2. Labels explain destinations. Icons reinforce labels rather than replacing them.
3. Advanced pricing and configuration stay available behind named disclosures.
4. Feedback distinguishes draft, saved locally, synced, queued, sent, and failed.
5. Staff-recorded approval is distinct from customer-authenticated acceptance.
6. Permissions and module switches apply to cards, counts, links, menus, and actions.
7. Preserve trade density where useful: takeoff and scheduling need information;
   adding empty space must not hide essential work.
8. Build on existing tokens and components. Keep forms, tables, and focus states consistent.
9. Controls work with keyboard, touch, zoom, and reduced motion.
10. Keep data entry connected to the job; reuse existing records and defaults.

## Roles and navigation

Target office structure: Today, Customers, Jobs, Money, More.
Target field structure: My day, Jobs, Time, Tools, More.
The first sprint uses existing real routes for primary shortcuts; grouped
Customers/Money/Tools destinations can evolve after task testing. Every permitted,
enabled module must remain reachable. Plan-locked modules retain upgrade behaviour.

Desktop: labelled, grouped sidebar with optional compact mode.
Phone: four role-relevant destinations plus More, all visibly labelled.
Canvas: preserve full-bleed drawing and specialist controls.

## Screen direction

### Today

Show actionable priorities and today's crew before secondary reporting. Priorities
may include blocked work, approved work needing scheduling, unbilled time and
materials, and overdue invoices. Use actual records and useful destination links.
Show clear empty states; do not manufacture activity or financial metrics.

### Estimates

Customer and work identity first, line items next, customer notes and preview
within easy reach. Pricing settings remain editable under a clear disclosure.
Preserve tax visibility, no-tax reasons, accounting holds, autosave, and print.
Draft: prepare and preview. Sent: record externally received approval. Accepted:
create or open the job, then schedule it. Payment and invoicing remain available.

### Job overview (later sprint)

Customer, site, current phase, next visit, crew, blockers, materials, and next
action. Only authorized roles see financials. Service calls use a short path;
commercial projects support phases, repeat visits, inspections, progress billing,
and closeout. Do not require a commercial workflow for a simple repair.

### Field (later sprint)

Keep task completion, photos, materials, and issue reporting close to the work.
Explain whether starting a task starts paid time. Display save/sync failures with
recovery. Test bright light, weak network, long job names, and one-handed use.

### Onboarding and marketing (later sprint)

Guide the user to a first useful quote. Ask for additional setup when relevant.
Offer editable electrical work templates without representing them as approved
engineering designs. Demonstrate the quote-to-payment journey on the website.
Make any deposit requirement as clear as the free-trial wording.
