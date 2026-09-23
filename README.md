# WhatsApp Bot

A single Node/TypeScript bot process owns the WhatsApp connection, router,
SQLite database and authenticated Fastify API. The React dashboard is served
by nginx. ComfyUI, Ollama and Auralis are external inference services.

## Setup

1. Create a local `.env` using `.env.example`. Set a unique `API_TOKEN` and your
   `COMFYUI_DIR`. Never commit the token or anything under `data/`.
2. Generate a token locally, for example with
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
3. Run `docker compose up -d --build bot-core web`.
4. Open http://localhost:8080, enter the token, and link WhatsApp.
5. Start GPU inference separately with `docker compose up -d --build comfyui`
   when Docker has NVIDIA GPU access. Set the paint backend to
   `http://comfyui:8188` in the dashboard. Ollama and Auralis remain host services.

Published ports bind to loopback. For remote use, put an authenticated HTTPS
reverse proxy in front; do not expose ComfyUI directly. All API routes require
a bearer token. Tokens are never accepted in URLs. `/api/health` reports API
liveness and the current WhatsApp connection state; linking is not required
for the dashboard to be healthy.

## Upgrading Existing Installations

- Back up the database and authentication directory before upgrading.
- `API_TOKEN` is now required by Compose and the API. Set it before restarting.
- Legacy name-only approvals are retained but no longer authorize messages.
  Re-select each intended chat in the dashboard, checking its ID, then remove
  the entries marked "reapproval required". Names are not migrated automatically
  because profiles and group names can be duplicated or impersonated.
- Group approval applies to that group only. Contact/phone approval applies
  to direct conversations, not every group containing that contact.
- Configuration writes require the `ETag` from `GET /api/config` as an
  `If-Match` header. Stale writes return 412; missing revisions return 428.
- Database migration version 1 adds the durable outbox without deleting
  existing configuration, contacts, reminders or tells.
- The backend runs as UID 1000. On Linux, ensure the mounted `data/` directory
  is writable by that UID before deployment. Do not loosen auth-file permissions.

## Delivery And Lifecycle

Due reminders and matched tells move transactionally into SQLite's `outbox`.
Jobs are claimed with a five-minute lease and marked sent only after the
transport resolves. Failures retry with exponential backoff, up to five
attempts; known WhatsApp disconnects pause delivery without consuming attempts.
Exhausted jobs remain with status `failed` for inspection. Never
blindly replay failed jobs: a timeout may mean WhatsApp accepted the message
but its acknowledgment was lost. Delivery is at-least-once, not exactly-once.

Chat handlers execute in order per chat with bounded intake. Expensive AI/media
jobs use a separate bounded queue with one job per chat and one running job
globally. These interactive jobs and games are not durable across restarts.
Shutdown stops intake, drains accepted work, disposes timers/streams and then
closes SQLite. After 30 seconds the process exits; outbox leases recover later.

Message bodies are no longer logged by incoming-message middleware. Analytics
and delivered outbox rows still contain message text: apply a retention policy
appropriate to your chats and protect backups as sensitive data.

## Backup And Recovery

Stop `bot-core` before copying all of `data/`, including the SQLite WAL/SHM files
if present and the `auth/` directory. Restart after the copy completes. For a
live backup, use SQLite's backup API; copying only an open `bot.db` is unsafe.
Test restoration into a separate directory, without simultaneously connecting
two bot instances with the same WhatsApp credentials. Restore a matching
application/database version; newer database versions fail closed.

## Development And Checks

Use Node 22. In both `bot-core` and `web`, run `npm ci`.

```text
npm --prefix bot-core run typecheck
npm --prefix bot-core run lint
npm --prefix bot-core test
npm --prefix bot-core run build
npm --prefix web test
npm --prefix web run build
```

Set `API_TOKEN` for normal backend development. `ALLOW_INSECURE_API=true` is an
explicit local-only escape hatch and binds the API to 127.0.0.1. The dashboard
dev server proxies to `BOT_CORE_URL` (default http://localhost:5000).

The ComfyUI base image and source revision, plus the working Torch/torchvision
nightly pair, are pinned in its Dockerfile. The one-day-offset torchvision
dependency override is intentional for that exact tested pair, not a general
ABI guarantee. Python requirements and OS repositories are not fully locked;
archive tested image digests and wheel artifacts for long-term reproducibility.
Validate image generation on the target GPU before rolling out a rebuilt image.