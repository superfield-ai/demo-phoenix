# demo-phoenix

A self-hosted AI knowledge base demo for financial services teams. Agents continuously ingest, index, and surface knowledge from connected sources, with role-based access control and per-label encryption.

## What it does

- **Autolearning KB** — documents are ingested and embedded automatically; retrieval improves over time
- **Role-based access** — Analyst, Advisor, Compliance, and Admin roles with clearance-level enforcement
- **Label encryption** — per-label content-key encryption so sensitive documents stay scoped to authorised roles
- **Passkey auth** — passwordless login via WebAuthn/passkeys
- **PWA** — installable progressive web app with offline support

## Quick start

Requires: [Bun](https://bun.sh), [Docker](https://www.docker.com), [k3d](https://k3d.io)

```sh
# Bootstrap the local cluster and start the dev server
bun run demo
```

Then open [http://localhost:5173](http://localhost:5173). Use the **Sign in as [Role]** buttons to explore each persona.

## Stack

| Layer    | Technology                          |
| -------- | ----------------------------------- |
| Runtime  | Bun                                 |
| Frontend | React + Vite (PWA)                  |
| Backend  | Hono (TypeScript)                   |
| Database | PostgreSQL + pgvector               |
| Infra    | k3d (local k8s) + Cloudflare tunnel |
| Auth     | WebAuthn / passkeys                 |
| AI       | Claude (Anthropic)                  |
