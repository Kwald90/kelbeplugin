# kelbeplugin

## Fishtape (electrical contractor SaaS)

Fishtape is a multi-company app for Canadian electrical contractors: CRM, jobs,
estimating, invoicing, crew and time, a plan canvas with box auto-placement and
CEC checks, wire runs, pipe bending and CEC calculators.

| folder | what |
| --- | --- |
| [`electrical-app/`](electrical-app/) | the installable web app (PWA), see its [README](electrical-app/README.md) |
| [`server/`](server/) | the API: Node 22, Fastify, PostgreSQL with row-level security, see its [README](server/README.md) |
| [`docs/`](docs/) | build plan, architecture, code research, field guides, security and compliance |
| [`deploy/`](deploy/) | local, staging and production setup |
| [`replica/`](replica/) | the original recon map, feature matrix and design tokens |

Start with [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md): decisions, the 13 layers,
contracts and who owns what.

Staging: https://tgelectrical.truecollarbuilt.com

The rest of the repo (`includes/`, `kelbe-project-tracker.php`) is the older
WordPress plugin and is not served.
