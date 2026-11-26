# Lavigo OS — Design Docs

| # | Doc | What's in it |
|---|---|---|
| 01 | [SRS](01-SRS.md) | Scope, definitions, functional requirements by screen (IDs like `PRC-2`), NFRs, acceptance script, risks, open questions |
| 02 | [DFD](02-DFD.md) | Level 0 context; Level 1 with 10 processes and 14 stores; Level 2 for Channel Gateway, Deal Desk, Payments & Dues, Supplier Procurement, Tickets |
| 03 | [System design](03-system-design.md) | Architecture, ADRs, repo layout, sequence diagrams, deal desk, jobs, security, Docker, CI, deployment |
| 04 | [Database schema](04-database-schema.md) | Conventions, ERD, state machines, seed spec. The schema itself is [design/schema.prisma](design/schema.prisma) (validated) |
| 05 | [Claude Code prompts](05-claude-code-prompts.md) | Phased build prompts P0–P8, schedule, review gates, post-delivery templates |
| — | [Demo reference](reference/lavigo-os-demo.html) | The owner demo; the visual and behavioural spec |

## Decisions in one line each

- **Stack:** Next.js App Router + TypeScript; Postgres + Prisma; Redis + BullMQ worker; Auth.js; Tailwind/shadcn; MinIO/S3; Caddy; all in Docker.
- **Two processes, one image:** `web` handles UI, actions and webhook ingress; `worker` handles provider sends, payments, PDFs and crons.
- **v1 has no AI/LLM** (decided 26 Nov, SRS §1.1). The inbox is staff-run, with a deal desk; supplier parsing is rule-based. The AI agent is v2; its design is kept in system design Appendix A and the DFD appendix.
- **Nobody can quote below the rules.** One pure pricing engine decides every allowed price on the server. Staff are capped at the staff limit, below that the owner approves in one tap, and below the floor needs the owner plus a second confirmation. v2's AI will call the same functions.
- **Sandbox channel** runs the identical pipeline, so the demo doesn't depend on Meta approvals landing by Saturday.
- **Tests only where things can really break:** pricing, seat-hold races, payment-webhook idempotency, webhook signatures, deal-desk price enforcement, supplier parser, dues planner, ticket ranking and PNR split, plus one e2e smoke.
