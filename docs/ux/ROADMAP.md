# Customer experience delivery roadmap

## Sequence

Timeboxes are planning estimates, not delivery promises. Technical discovery and
team capacity determine dates. Sprint 01 starts implementation now while research
and customer-facing design continue as follow-up work.

| Phase | Indicative window | Deliverable | Exit criteria |
| --- | --- | --- | --- |
| Discovery | Weeks 1-2 | Owner, office, foreman, and electrician task observations | Record task times, errors, assistance, and five highest-friction moments |
| Foundation | Weeks 3-4; first slice starts now | Navigation, focused Today, consistent controls | All permitted modules reachable; role/module checks hold; phone and desktop reviewed |
| Quote to job | Weeks 5-7; editor slice starts now | Quote hierarchy, customer preview, job overview and handoffs | Complete quote-to-job scenario without retyping customer/scope; existing accounting tests pass |
| Customer pilot | Weeks 8-10, subject to backend discovery | Secure approval, visit information, changes, payment and handover | Customer-scoped access tests, versioned approvals, failure recovery, pilot feedback |

## Prioritized backlog

| ID | Priority | Work | Dependencies | Acceptance |
| --- | --- | --- | --- | --- |
| UX-01 | P0 | Labelled desktop and phone navigation | Existing routes, permissions and switches | Visible names; More exposes every allowed module; no inaccessible destination |
| UX-02 | P0 | Today action priorities | Existing job, estimate, work-task, invoice records | Each item reflects real state and points to a useful existing screen |
| UX-03 | P0 | Estimate hierarchy and next step | Existing editor, tax, preview and integration helpers | Advanced pricing remains editable; approval wording truthful; job conversion retained |
| UX-04 | P0 | Zoom, focus, touch and motion polish | Shared CSS and shell | Zoom enabled; main touch controls comfortable; visible focus; reduced motion honoured |
| UX-05 | P1 | Job overview and service/project variants | Workflow discovery | Scope, next milestone, blockers and crew visible; financials permission-scoped |
| UX-06 | P1 | Field task/time clarity and save recovery | Time and sync contracts | User understands paid time versus task status and can recover failed updates |
| UX-07 | P1 | Progressive onboarding and templates | First-use observations | First useful quote without completing unrelated setup |
| UX-08 | P1 | Customer quote and change approval | Customer journey; auth/version contract | Exact approved version retained; links scoped/revocable; stale approval handled |
| UX-09 | P1 | Appointment and completion page | Customer scope and notification preferences | Correct appointment, preparation, selected documents, and contact information |
| UX-10 | P1 | Payment/receipt journey | Existing payment service | Accurate pending/paid/failed/cancelled states; no duplicate collections |
| UX-11 | P2 | Marketing journey and trial clarity | Product readiness and commercial decision | Claims match working features; deposit disclosed at each trial entry |

## Measurement

Collect a baseline before attributing improvements. Use consenting pilot users and
avoid capturing customer scope text, addresses, or financial content in analytics.

| Measure | How to measure | Proposed target, to validate |
| --- | --- | --- |
| Find a core destination | Time and assistance in a first-use task | At least 90% completion without help |
| First quote | Start of setup to useful preview, same scenario | 30% faster than baseline |
| Quote-to-job handoff | Re-entered fields and conversion errors | No repeated customer/scope entry; no duplicate jobs |
| Field task update | Tap count, save feedback, recovery | User can identify saved versus pending state |
| Approval turnaround | Quote delivery to customer decision | Improve relative to baseline; segment service/project |
| Payment completion | Successful payment / attempts, excluding test traffic | Improve relative to baseline |
| Support demand | Navigation, setup, and sync tickets per active company | Reduce relative to baseline |

## Release and validation

Run relevant unit suites, all PWA unit tests, and CSP checks. Exercise role switches,
disabled modules, plan locks, accounting holds, draft/sent/accepted estimates, and
offline behaviour. Review phone and desktop layouts and keyboard navigation.
Record what was actually executed in the sprint log; missing runtime or hardware
checks remain explicit. Deployment follows existing runbooks as a separate step.
