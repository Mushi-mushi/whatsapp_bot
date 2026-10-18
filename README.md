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

The bot owner can manage inference features in WhatsApp with `bot.services`:
`bot.services off` disables Ollama-backed AI commands and ComfyUI image/video
generation, while `bot.services on` re-enables them. Use
`bot.services off ollama` or `bot.services off comfyui` to disable one service,
and `bot.services status` to check both.

Published ports bind to loopback. For remote use, put an authenticated HTTPS
reverse proxy in front; do not expose ComfyUI directly. All API routes require
a bearer token. Tokens are never accepted in URLs. `/api/health` reports API
liveness and the current WhatsApp connection state; linking is not required
for the dashboard to be healthy.

An active `bot.siesta` can be cancelled from the dashboard's **Connection** tab.

Each player may use `bot.siesta` only once per UTC day within a given chat. A
second attempt that day — or a player an admin has armed — makes the bot rebel
and put that *player* to sleep instead: their messages are deleted for the
requested duration (only in groups where the bot is an admin) and they are told
to go to sleep. The dashboard's **Sleep** tab lets the authenticated owner put a
player to sleep now (pick a synced contact by name or paste a WhatsApp JID, for a
chosen number of minutes), arm a player so their next `bot.siesta` triggers the
sleep, and wake anyone currently sleeping or armed. The list shows each player's
contact display name (falling back to the JID). Forced-sleep state is keyed per
chat and per player and persists across restarts.

WhatsApp automatically reconnects using the saved session after two failed
health probes or when incoming events remain buffered across two consecutive
minute-spaced checks. Repeated reconnect attempts back off from 2 seconds to
a maximum of 30 seconds; receiving messages resets the backoff. Quiet chats
alone do not trigger recovery. This recovery preserves credentials; the
dashboard's manual re-link action is still available when fresh pairing is needed.

## Continuous Integration And Merge Protection

The Checks workflow runs on pushes, pull requests, merge queues and manual
dispatch. It checks tracked runtime-data paths before installing project
dependencies, then runs backend typechecks/lint/tests/build, dashboard
tests/build and independent production Docker builds for both services.
Docker builds use the repository-root context, publish no images and require no
runtime credentials, live database, WhatsApp connection or inference services.

Run the data guard locally before committing:

```sh
node --test .github/scripts/check-tracked-data.test.mjs
node .github/scripts/check-tracked-data.mjs
```

The guard rejects tracked runtime/auth/backup directories, SQLite databases and
sidecars, local environment files (except `.env.example`), `creds.json`, logs and
any tracked files matching current Git ignore rules. It inspects Git's index,
not private local file contents, and still catches known runtime paths if their
ignore rules are removed. This is a filename/index safeguard, not a general
secret-content scanner or a scan of previous commits. Never put real credentials
in source or environment examples; exposed credentials must be rotated.

The stable **CI required** check succeeds only if the guard, existing `test` job
and both Docker builds succeed; failed, cancelled or skipped prerequisites do
not pass the gate. To enforce it after this workflow has been pushed and run:

1. Open repository **Settings → Rules → Rulesets** (or branch protection).
2. Target `main`, require a pull request before merging, and require the
   **CI required** status check from GitHub Actions.
3. Require the branch to be up to date before merging, and avoid bypasses if
   all changes must be checked.

Workflow files alone cannot enable repository-level enforcement. A repository
administrator must apply these settings, subject to GitHub plan availability.
Do not rename the gate without updating the required status check.

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
- Invalid persisted configuration now stops startup (or fails an API read)
  instead of silently loading defaults. The original database value is preserved;
  restore a valid configuration from your backup before restarting.
- Database migration version 1 adds the durable outbox; version 2 adds group
  pets and picture-delivery metadata; version 3 adds per-chat siesta discipline
  (daily limits and forced-sleep state). Version 4 introduces chat-scoped user
  memory and profiles. **It permanently deletes existing global user messages
  and profiles** because their chat names cannot safely establish chat identity.
  Profiles rebuild from new messages; no legacy dossiers are carried forward.
  All preserve existing configuration,
  contacts, reminders and tells. Back up before upgrading; older binaries
  cannot open a newer database.
- Database version 5 adds a nullable outbox failure timestamp and an index for
  operations monitoring, preserving existing rows and chat-scoped memory.
  Old unresolved failures show an unknown failure time until another failure
  occurs. This does not repeat the version 4 memory reset.
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
jobs use a separate bounded queue with up to three pending jobs per chat and one
running job globally. Dashboard profile refreshes share that queue; a full queue
or a duplicate pending profile refresh returns HTTP 503 so the owner can retry.
These interactive jobs and trivia/duel games are not durable across
restarts. Group pets, rescue progress and pet deliveries are durable.
Shutdown stops intake, drains accepted work, disposes timers/streams and then
closes SQLite. After 30 seconds the process exits; outbox leases recover later.

`bot.trivia stop` cancels a session even between questions. Pending question
preparation cannot revive a stopped session, and scheduled send failures are
logged and end the affected session rather than becoming unhandled rejections.
Command names match exactly: `bot.asking` does not execute `bot.ask`.

Profile refreshes only mark the messages sampled for generation as processed.
AI memory, personalization, named profile lookups and impersonation are isolated by
stable WhatsApp chat ID, never chat display name. The same person has separate
history, retention limits and profiles in each group or DM. Renaming a chat
does not change its memory; two chats with the same name never share it. Unknown
phone/LID aliases remain separate rather than being merged by display name.
Named lookups use the latest display name recorded in the current chat and refuse
ambiguous matches; automatic mention context skips ambiguous names.

### WhatsApp identity aliases

Person identity, conversation scope, transport address and display name are
separate. Verified PN/LID pairs from WhatsApp contacts, message metadata and group
participants resolve to a device-normalized phone JID when available. Names
never establish an alias, and opaque LID digits are never interpreted as a phone.
Conflicting phone associations are rejected and logged, not silently reassigned.

The existing contacts table also persists aliases with no display name; these
entries do not appear in the contact/chat pickers. Partial updates preserve known
phones and names, and saved phone-contact names take precedence over LID profile
names. Alias updates are persisted before the transport accepts them.

Incoming messages retain their original chat/sender addresses for replies,
quoting and deletion. Separate resolved identities drive DM approvals, AI memory
scope, discipline and group-admin matching. A participant's identity never approves
an otherwise unapproved group. Outgoing DM labels describe the recipient, not the
linked account.

For new AI memory, verified PN/LID forms of one DM use the same conversation
scope; groups remain isolated by their group IDs. Previously stored memory and
profiles are **not migrated, merged or deleted**. Records created under an
unresolved LID (or an older LID DM scope) remain available through the profiles
dashboard but are not automatically included in the new canonical scope.
Existing discipline rows remain effective through verified alias-aware reads;
explicit sleep/wake actions update equivalent restrictions without rewriting
historical daily allowances. No database schema change is required.

### Chat-scoped people and statistics

Tells, last-seen, karma, sentiment scores and trivia/duel scores now belong to a
verified person **within one chat**. An independent participant directory records
approved, deduplicated activity (including short messages, media, commands and
owner activity), even when AI memory is disabled. Bot-generated replies do not
create activity. Names are display labels, not database/player keys.

Named commands resolve only a unique latest name observed in the current chat.
Missing or ambiguous names are rejected; saved contacts alone do not prove chat
membership. After a rename, use the new name. Self-karma is checked by identity,
and `bot.score` without a name uses the sender's own identity. Sentiment top-message
commands cannot quote another chat's messages.

Trivia allows distinct same-named players, preserves scores across renames and
uses identity for answer eligibility, duel membership, totals and trophies.
Duplicate names on leaderboards include an identity label. Verified aliases
are recognized even when learned during a game. Insult-duel answers are accepted
only from the challenger, not a same-named bystander.

The additive **schema 9** migration creates the participant directory and new
identity-keyed karma/game tables, and adds nullable scope columns to tells and
sentiment. Historical name-only seen/karma/game rows remain in their original
tables, unattributed and excluded from new lookups, resets and monthly rollover.
Old sentiment rows remain unattributed and subject to the existing retention
policy. No historical AI memory/profile reconciliation is performed.
New scoped statistics start fresh; names are never used to guess ownership.
Back up before upgrading: older binaries cannot open schema 9.

### Ask request limit

`bot.ask` and `bot.ask.raw` share a persistent limit of **10 requests per person
per chat**, including the linked account's own requests and inline model overrides.
The tenth request is allowed and starts a **one-hour cooldown**. Cooldown expiry
grants another ten requests; **UTC midnight also resets the quota**, even if the
hour has not elapsed. Rejected requests report the remaining wait and do not
extend it. Requests below ten accumulate throughout the UTC day.

Model-list requests (`bot.models`, `bot.ask models`, `bot.ask model=?`) do not
count and remain available during cooldown. Empty/disabled requests and model
overrides without a question do not count. Once an inference request is reserved,
it counts even if Ollama or reply delivery fails; concurrent requests cannot
exceed ten. Other AI commands are not included in this limit.

Verified identity aliases share quota, including after an alias is learned;
duplicate display names do not. Quotas survive restarts. The additive **schema 8**
migration creates `ask_quota` without modifying existing bot data. Back up before
deploying: older binaries cannot open a newer schema. The current application
and backup verifier require schema 9 (older backups need a matching-version verifier).

The profiles API exposes an opaque `sender_key` for each chat/person pair plus
`chat_id` and `chat_name` (null if unknown). URL-encode the key in API paths. The dashboard
shows both chat name and ID so duplicate chat names can be distinguished.
Refreshing or forgetting an entry affects that chat/person pair only.

Forgetting a user invalidates queued and running refreshes in that chat before
deleting their profile and stored messages. Later new messages may start learning again;
forgetting is not a permanent opt-out.

The dashboard reconnects its live status stream when the API token changes and
uses `/api/status` snapshots while retrying interrupted streams. Reverting
configuration edits to the saved values clears the unsaved-changes indicator.
Query cards distinguish loading, failed and successfully empty results, with
retry actions for unavailable data and AI services. Fields have associated labels
and hints; icon-only profile actions expose accessible names.

Numeric configuration fields keep blank, out-of-range and fractional integer
drafts visible with validation errors instead of silently substituting defaults.
Valid zero and fractional values are retained where the setting permits them.
Correct invalid settings before saving or changing sections; confirmed Reload
discards them. Background configuration refreshes do not overwrite invalid drafts.
Backend validation remains authoritative. Pet settings retain their independent
save workflow; sleep duration validation never silently clamps input.

Message bodies are no longer logged by incoming-message middleware. Analytics
and delivered outbox rows still contain message text: apply a retention policy
appropriate to your chats and protect backups as sensitive data.

### Data Retention

The **General** tab controls automatic cleanup (enabled by default), with
90 days for sentiment/complaint analytics and 30 days for sent/cancelled outbox
records. Limits are whole days from 1 to 3650. Cleanup runs at startup and every
24 hours using the latest saved settings, including eligible pre-existing data.
Changes take effect on the next pass; disabling cleanup does not restore deleted
records. Failures roll back the transaction and are logged; the next daily pass
retries. Successful passes log deletion counts without message contents.

Analytics age uses the recorded event timestamp. Delivery record age uses its
**queued/created timestamp**, not its completion time (which is not recorded).
Only records strictly older than the cutoff are removed. Pending, sending and
failed deliveries are always protected. Pet state/events, trivia/duel scores,
karma, reminders, tells, configuration and AI memory/profiles are untouched.
Removing sentiment history changes summaries derived from that history.

This does not purge existing backups or WhatsApp authentication. SQLite may
reuse freed pages without shrinking the file; cleanup is not secure erasure.
Protect backups separately and retain them according to your own policy.

## Reminder Management

The authenticated dashboard's **Reminders** tab lists reminders still in the
scheduler, with chat name and stable ID, recipient (if named), message and due
time in the browser's local timezone. It refreshes every 10 seconds while open.
Overdue reminders may briefly remain scheduled until the delivery worker's next
pass. Create reminders in WhatsApp using `bot.remind`; dashboard creation and
editing are intentionally not provided.

`GET /api/reminders?page=1` returns `{ reminders, total, page, pageSize, sampledAt }`
with 50 rows per page, ordered by due time then ID. Pages are positive whole
numbers up to 1000000. Chat names come from the current chat directory and can be
null; IDs remain visible to distinguish duplicate/unknown names. Listing never
enqueues, claims or delivers a reminder. Pages reflect a changing scheduler, not
a frozen history: delivery handoffs can shift rows between pages.

After confirmation, `DELETE /api/reminders/:id` cancels only the scheduled row
and returns `{ ok: true, cancelledId }`. The atomic scheduler-to-outbox handoff
and cancellation cannot both win: if the row has already left the scheduler (or
was cancelled elsewhere), the API returns **409**, not a success. Queued,
sending, sent and failed outbox records are never cancelled by this endpoint.
Invalid IDs/pages return 400; all reads and cancellations use existing API
authentication and send `Cache-Control: no-store`. The reminder list contains
private message text and identities; only expose the dashboard to trusted users.

Cancellation takes effect immediately, independently of configuration Save.
Errors are explicit; stale lists are marked and stale cancellation controls are
disabled until a successful refresh. A confirmed cancellation is removed locally
even if the subsequent refresh fails. Delivery aggregate counts are available in
Operations; individual reminder delivery history is not provided.
No schema migration or changes to existing reminder creation/delivery are needed.

## Pending Tells

The **Pending tells** tab lists and cancels tells not yet handed to delivery.
It shares the Reminders pagination, 10-second refresh, confirmation, stale-data
handling and immediate (not configuration Save) cancellation behavior.
Create tells in WhatsApp with `bot.tell`; dashboard creation/editing is not provided.
New tells are bound to a unique observed recipient identity and the originating
chat. They are delivered only when that person becomes active in that chat,
including after renames or verified address changes. Delivery uses the observed
transport address and preserves the existing transactional outbox handoff.
Legacy name-only tells are **held, never automatically delivered**. They remain
visible and cancellable; cancel and recreate them in WhatsApp to select a verified
recipient. Tells already queued in the outbox are not changed by this migration.
The list shows original recipient/sender labels, message, creation time and, for
new tells, the chat and target identity. These are private contents: restrict
dashboard access to trusted users.

Authenticated, `Cache-Control: no-store` endpoints:

- `GET /api/tells?page=1`: `{ tells, total, page, pageSize, sampledAt }`, 50 per
  page ordered by creation time then ID. Same page limits as Reminders.
  Each entry includes `chatId`, `chatName`, `targetId` (nullable for legacy rows)
  and `legacy`; legacy rows have no inferred scope.
- `DELETE /api/tells/:id`: `{ ok: true, cancelledId }`; invalid IDs return 400.
  The pending-row deletion and transactional handoff are mutually exclusive.
  A missing/already handed-off/already cancelled row returns 409 and never
  cancels a queued, sending, sent or failed outbox delivery.

## Operations Overview

The dashboard's **Operations** tab polls `GET /api/operations` every five seconds
while open (background tabs may pause polling). The endpoint uses the existing
API authentication and sends `Cache-Control: no-store`. This overview endpoint is read-only:
it never claims deliveries, recovers leases, retries failures or changes config.
Manual Refresh and error/retry states are available; a failed refresh keeps the
last successful snapshot explicitly marked as potentially stale.

### Service Diagnostics

The Operations service panel separately polls authenticated
`GET /api/operations/services` every 30 seconds while mounted. Server results
are cached for 30 seconds and concurrent requests share checks; saving changed
service URLs or enable/provider settings invalidates that server cache.
Manual refresh respects the same cache. API responses use `Cache-Control: no-store`.
Service failures do not block the queue/delivery/backup overview.

Checks run concurrently with three-second timeouts, using only GET requests:
Ollama `/api/tags`, ComfyUI `/system_stats`, and Auralis `/health` (expects
`{"status":"ok"}`). No chat, transcription upload, model loading or workflow
execution is triggered. The checks use the same saved base URLs as inference;
redirects and credential-bearing URLs are not followed. Disabled AI/paint
features are skipped; transcription is skipped if transcription or audio
download is disabled, and unsupported transcription providers are labelled.

Each result includes its check time, elapsed request/response-check latency and
HTTP status where available. Disabled, unsupported, invalid configuration,
timeout, network failure, HTTP failure and malformed/unexpected responses are
distinct states. Raw responses, URLs and error text are not sent to the dashboard.
Unexpected failures are logged with the service category, not response contents.
An available endpoint does not certify model installation, GPU capacity or
successful generation. Failed panel refreshes retain explicitly stale results.

### Queue And Delivery Monitoring

- **Background jobs:** capacity, running/queued work, queue age, execution
  duration, completed/failed counts and rejection counts by reason. Counters
  and the latest 20 thrown execution failures reset on process restart.
  A completed handler may have handled a service error internally; these are
  not comprehensive AI/service health metrics.
- **Durable deliveries:** all retained pending/sending/failed/sent/cancelled
  outbox rows, pending work ready now, pending retries, expired leases and the
  next attempt or lease-recovery eligibility time. These rows cover reminders,
  matched tells and pet announcements, not ordinary bot replies. Eligibility
  is not a delivery guarantee: transport connectivity or pet state may defer it.
- **Recent unresolved delivery failures:** at most 20 rows, ordered by last
  failure time, one per delivery rather than one per attempt. Successful
  retries and cancellations leave the list; exhausted failures remain.
  Version 4 failures have an unknown failure timestamp until another failure.
  Delivery state and new failure timestamps survive restarts.

Only bounded metadata is exposed: no chat/person identifiers, message bodies,
prompts, credentials or raw errors. Consult server logs for diagnostics (delivery
IDs help locate delivery failures). Retry controls are separate from the
read-only overview and require explicit confirmation; outbox cancellation is
not provided.

### Failed-Delivery Recovery

**Operations → Failed-delivery recovery** lists all exhausted deliveries in
50-row pages, newest failure first (ID breaks ties). The list polls every 10
seconds independently of the overview and service checks. Failed refreshes
retain explicitly stale data and disable retry controls. Inspect a delivery to
load sanitized attempt history; message bodies, identities, claim tokens and raw
errors are never returned by either endpoint.

**Retry once** requires confirmation acknowledging that a previous send might
already have succeeded and that retrying may send a duplicate. Each confirmation
permits **one additional send attempt**, not a new five-attempt automatic cycle.
It reuses the existing outbox row, sends nothing inline, and preserves normal
transport readiness and pet-state defer/cancel/on-sent checks. Scheduling a
retry is not confirmation of delivery. There is no bulk retry.

Authenticated, `Cache-Control: no-store` endpoints:

- `GET /api/operations/failed-deliveries?page=1` returns
  `{ deliveries, total, page, pageSize, sampledAt }`. Page limits match Reminders.
  Each row contains only ID, attempt budget, manual retry count, last failure
  timestamp and a controlled `timeout`, `lease-expired`, `send-error` or `unknown`
  category. Old failure timestamps/categories may be unknown.
- `GET /api/operations/deliveries/:id/history` returns `{ id, attempts, total }`
  for any retained outbox state; missing/pruned IDs return 404. History records
  claim start/finish times, outcomes, manual-retry round and sanitized failure
  category, newest first. Invalid IDs return 400.
- `POST /api/operations/deliveries/:id/retry` requires JSON
  `{ "expectedRetryCount": 0, "acknowledgeDuplicateRisk": true }`, using the
  current count from the list, and returns `{ ok: true, retriedId }`.
  Missing/invalid acknowledgement, count or ID returns 400. An atomic
  failed-state/count check returns 409 for stale or concurrent requests, missing
  rows or any state other than failed. Even if a manual attempt fails again, an
  old confirmation cannot schedule another retry.

The additive **schema 6** migration preserves all existing data and claims,
adds a manual-retry counter and starts recording claim history. Earlier attempts
are not reconstructed. At most 50 claims per delivery are retained, including
deferred/cancelled/expired claims. Deferred claims do not consume a send attempt.
History survives restarts and is deleted with its outbox row by the existing
sent/cancelled retention policy; pending/sending/failed rows remain protected.
The existing `attempts` field is the five-attempt **budget used**, not a lifetime
send count: a manual retry leaves one slot (4/5 used), then its claim uses 5/5.
Manual-retry rounds and retained history distinguish subsequent attempts.
Back up the database before deploying this migration; older schema-5 binaries
cannot open a migrated schema-6 database.

### Administrative Audit Trail

**Operations → Administrative audit trail** shows paginated, metadata-only
administrative API history, polling every 10 seconds independently of other
panels. Loading, read errors, retry, empty and explicitly stale snapshots are
distinct. New entries and retention can shift pages; Previous remains available
after an empty or failed later page. Times use the browser's local timezone.

`GET /api/operations/audit?page=1` uses existing API authentication and
`Cache-Control: no-store`, returning
`{ entries, total, page, pageSize, sampledAt, retentionDays, maxEntries }`.
Pages contain 50 records, newest request ID first; valid pages are whole numbers
from 1 to 1000000 (invalid input returns 400). Reads never create audit entries.
There are no audit deletion or replay controls.

Each record has an action, target reference (if applicable), start/completion
timestamps, actor category, HTTP status and outcome:

- `succeeded`: the server prepared a successful response; not proof of message
  delivery or client receipt. A delivery retry records scheduling only.
- `rejected`: the server rejected the request, including validation errors,
  stale revisions and cancellation/retry conflicts.
- `failed`: a server/upstream error; changes may already have occurred.
- `unknown`: a request is in progress or was interrupted before its outcome
  could be persisted. These remain unknown across restarts, never inferred as
  successes or automatically replayed.

Covered actions include reminder/tell cancellation, manual delivery retries,
configuration saves, pet save/enable/disable/pause/resume/challenge/evolution,
profile refresh/forget, siesta cancellation, player discipline, trivia
reset/month-close, contact resync, pairing and relinking. Only administrative API
requests are covered, not bot commands, background worker actions, read requests
or rejected authentication attempts. New mutation routes must be added to the
controlled action catalogue; API registration fails if one is missing.

The shared bearer token cannot identify a named operator: the actor is
`authenticated-api`, or `local-insecure-api` for explicitly enabled legacy local
access. Numeric reminder/tell/delivery IDs remain usable references. Chat,
profile and player targets use domain-separated HMAC-SHA256 opaque references,
keyed by the existing API token. They are stable while that token is unchanged,
but change on token rotation (or API-process restart in insecure mode).
References allow correlation, not recovery of raw identities. No names, phone
numbers, chat IDs, messages, prompts, credentials, request/response bodies,
configuration values, IP addresses, raw errors or revision headers are stored.
Global actions and invalid/unavailable targets have a null target reference.

The additive **schema 7** migration preserves existing state and starts a new
history; earlier actions are not reconstructed. Audit rows survive restart and
are included in normal database backups. Retention is **90 days with a hard cap
of the latest 10,000 requests**, enforced on each new entry and by the existing
startup/daily retention worker, independently of the analytics/delivery
retention toggle. Audit cleanup does not prune other protected bot data.
Older backup files retain their own historical snapshot until backup retention
removes them. This database-backed history is not tamper-proof.

A durable unknown-outcome entry is inserted **before** an authenticated mutation
executes. If that insert or required retention fails, the mutation is blocked
with an explicit server error. Outcomes are persisted before responding. If
completion persistence fails after a mutation, the API logs and returns an error
and the record stays unknown; inspect current state before retrying because the
action may already have applied. Audit persistence and arbitrary asynchronous
external operations are not one atomic transaction.
Back up before deploying schema 7; schema-6 binaries cannot open it.

## Shared Group Pet

Pets are opt-in, with one independent pet per WhatsApp group ID. First approve
the group in the dashboard, then have the linked-phone owner or a group admin
send `bot.pet enable Mochi` **inside that group**. Group approval alone never
creates a pet. Anyone in the approved group can help care for it.

The dashboard's **Pets** tab also lets the authenticated owner spawn and name
a pet, choose its initial species, pause/resume/disable it, and edit settings
independently for each saved approved group. Use **Spawn pet** or **Save pet
settings** in that tab; the header's **Save changes** button is for general
configuration, including group approvals. Pet writes use separate settings
revisions so concurrent in-chat changes cannot be silently overwritten.

Per-group settings include UTC waking hours, first-request delay (default
15 active minutes), minimum/maximum spacing (8-12 active hours), daily cap
(3 per UTC day; 0 disables new requests), recent-activity window (6 hours),
feeding/game deadline (30 active minutes), and silence duration (2 minutes).
Intervals and deadlines are validated server-side. Changes to response
deadlines apply to future requests, not a challenge already delivered.
Changing interval bounds schedules the next request from the current pet clock;
the first-delay setting applies while the initial request is still unscheduled.
Evolution and neglect thresholds remain fixed game rules.

The Pets tab shows **healthy time remaining until the next form**, as a
days/hours/minutes/seconds countdown. Live status refreshes every 15 seconds
without replacing unsaved editor changes. The countdown freezes while paused,
disabled, hibernating, offline, or when any need is critical. Bot siesta does
not affect pet care, requests, or commands.
It holds if fresh status is unavailable; it is not a guaranteed wall-clock ETA.
The final form displays "Final form unlocked!" instead of a timer.

**Evolve now** asks for confirmation and advances exactly one form, setting
healthy-time progress to that form's usual threshold. It preserves name,
species, care stats and settings, cancels any active/queued request, and queues
an illustrated evolution announcement (delivered during waking hours).
It requires an enabled, resumed, approved, online pet that is not hibernating,
and cannot advance beyond the final form. The API checks the displayed stage
so retries or another open dashboard cannot accidentally advance it twice.
Forced evolution does not save pending editor changes or heal critical needs.

**Request now** in the Pets tab queues the selected **Request type**: Food,
Water, Cleaning, Number game or Silence, regardless of evolution stage.
The default **Random** option keeps normal stage unlocks. Automatic requests
still follow stage unlocks, unaffected by the manual selection. Requests use
saved settings without saving any pending editor changes.
Manual requests override waking hours, recent-activity requirements, spacing
and the daily cap (including zero), but require an enabled, resumed, approved,
online pet that is not hibernating and has no active or queued request.
The request timer starts after delivery; the manual request counts toward
the daily total and resets the next automatic interval. Pausing, disabling
or removing approval still cancels its delivery normally.

| Command | Purpose |
| --- | --- |
| `bot.pet` or `bot.pet status` | Current portrait, stats and evolution progress |
| `bot.pet help` | Rules and command list |
| `bot.pet feed` | Restore food, or leave a rescue snack |
| `bot.pet water` | Restore hydration |
| `bot.pet clean` | Restore cleanliness |
| `bot.pet play` | Restore happiness and a little energy |
| `bot.pet answer <answer>` | Answer a number game or rescue riddle |
| `bot.pet revive` | Show the shared two-step rescue quest |
| `bot.pet enable [name] [species=fox]` | Owner/admin: create or re-enable this group's pet |
| `bot.pet species` | List available species |
| `bot.pet rename <name>` | Owner/admin: change its name (up to 40 characters) |
| `bot.pet pause` / `bot.pet resume` | Owner/admin: freeze/resume care and progress |
| `bot.pet disable` | Owner/admin: stop the feature without deleting progress |
| `bot.pet hours 8 22` | Owner/admin: set waking hours in UTC; overnight ranges work |

New pets randomly become a **Cloud Bird** (`bird`), **Ember Fox** (`fox`),
**Moon Cat** (`cat`), or **Moss Dragon** (`dragon`). Choose explicitly with
`bot.pet enable Mochi species=fox`; the species argument may appear before or
after the name. Omitting the name uses Mochi. Species is fixed for the pet's
lifetime: pause, disable, re-enable, revival and devolution never reroll it.
Existing pets remain cloud birds, including their queued picture deliveries.

Each species has five forms, each with a distinct 512x512
portrait and a sleeping variant. Pictures are rendered locally from bundled
vector artwork; no inference service, downloaded art or paid API is needed.
Status and pet events include pictures; routine feeding/playing acknowledgements
are text. Stage emoji are also included in captions.

| Form | Cumulative healthy time | New request |
| --- | --- | --- |
| Cloud Egg | Start | Feeding, water, cleaning |
| Cloud Chick | 1 day | Guess a number from 1 to 5 |
| Breeze Bird | 7 days | Two-minute group silence |
| Sky Guardian | 21 days | All previous requests |
| Aurora Phoenix | 60 days | Final form |

The table above shows the cloud-bird names. Foxes evolve from Ember Egg to
Ember Kit, Spark Fox, Flame Guardian and Solar Fox; cats from Moon Egg to
Moon Kitten, Dusk Cat, Lunar Guardian and Celestial Cat; dragons from Moss Egg
to Moss Hatchling, Fern Drake, Forest Guardian and Ancient Dragon.
All species share the same evolution thresholds, care rules and request unlocks.

Food and hydration each decay from 100 to 0 over 48 active hours without care;
cleanliness and happiness over 72 active hours. Energy recovers during the pet's
sleeping hours. Feeding, watering, cleaning and playing have separate one-hour,
group-wide cooldowns. Watering and cleaning each restore 35 points, capped at
100. A delivered care request bypasses the matching care action's cooldown.
Healthy time advances only while all five stats exceed 20. Existing pets start
the new hydration and cleanliness stats at 100 without losing progress.
Water and cleaning requests are available from the egg stage and use the
same response deadline as feeding/game requests. The dashboard displays both
new stats; automatic requests and Request now can choose either new care type.
During hibernation, water/cleaning do not replace the snack-and-riddle rescue:
revival restores all five needs to 60 and keeps the existing grace period.

The pet makes at most three requests per UTC day, spaced 8-12 active hours
apart (first request after 15 active minutes). It only starts requests during
waking hours in groups with human activity in the last six hours. Only one
request can be active. Care/number requests default to 30 minutes; a missed
request costs 20 points from its matching need. Breaking a silence request
costs 20 energy; silence asks for two full minutes with no human messages,
including owner chatter, media and commands. Bot output and duplicate
deliveries do not count. Silence never mutes participants or deletes messages.

Request windows start after WhatsApp acknowledges delivery. Unsolicited pet
pictures wait until waking hours, without blocking ordinary reminders.
Failures use the existing durable outbox's retry policy; delivery remains
at-least-once, so an ambiguous acknowledgement can produce a duplicate picture.

When any stat stays critical (20 or below) for 8 active hours, the pet
hibernates. Another 48 active hours of hibernation removes **one** form,
once per neglect episode; the egg cannot devolve further. The pet never dies.
Rescue requires a snack and the displayed dream-riddle, in either order.
Progress is shared and saved; one person can do both steps, and rescue has no
expiry. Revival restores stats to 60 and grants a 24-active-hour grace period.
If it devolved, healthy-time progress resets to the lower form's threshold:
the group must earn the next evolution again.

Pause, disable, removed group approval, WhatsApp disconnects/stale connections,
and process downtime freeze pet time and neglect. Bot siesta does not affect the
pet. Long
scheduler gaps are treated as downtime rather than backfilled. Pause/disable
and removed approval also cancel queued pet notifications and active requests.
An interrupted silence challenge is cancelled without penalty because offline
silence cannot be verified; other delivered request windows freeze and resume
across downtime. Re-enabling keeps the existing pet, not a fresh replacement.

## Backup And Recovery

Stop `bot-core` before copying all of `data/`, including the SQLite WAL/SHM files
if present and the `auth/` directory. Restart after the copy completes. For a
live backup, use SQLite's backup API; copying only an open `bot.db` is unsafe.
Open the source database directly with a SQLite client for this operation, not
the application's database opener (which runs migrations). Verify the backup
with `PRAGMA integrity_check` before upgrading. A database-only backup does not
include WhatsApp authentication files; protect and back those up separately.
Prefer storing backups outside the repository. Runtime `data/`, `auth/`,
`backup/`, `backups/`, SQLite database files and their sidecars are ignored by
Git, as are local environment files. Ignore rules do not protect files already
tracked by Git; check `git ls-files` before committing runtime-related changes.
Test restoration into a separate directory, without simultaneously connecting
two bot instances with the same WhatsApp credentials. Restore a matching
application/database version; newer database versions fail closed.

### Automated Database Backups

Compose enables a SQLite online backup at startup and every 24 hours while the
process runs. Backups do not need a WhatsApp disconnect or database downtime.
Configure the host storage and retention in the ignored local `.env`:

```dotenv
BACKUP_HOST_DIR=../whatsapp_bot_backups
BACKUP_RETENTION_DAYS=14
```

Choose a dedicated directory **outside the repository**. Compose mounts it at
`/backups`; on Linux it must be writable by the backend's UID 1000. Use forward
slashes in Windows Compose paths. Retention accepts whole days from 1 to 3650;
invalid values fail startup instead of silently changing policy. Restart the
backend after changing these environment settings. Standalone (non-Compose)
runs use `BACKUP_DIR` as the destination; unset/blank disables automatic backups.
Compose supplies `BACKUP_DIR=/backups`.

Each pass uses SQLite's backup API, opens the isolated copy without application
migrations, checks `integrity_check` and `foreign_key_check`, switches the copy to
standalone DELETE journal mode, then atomically publishes a
`bot-auto-<timestamp>-<uuid>.db` file. Files are created with owner-only permissions
where the filesystem supports them; protect the host directory and backups too.
The automated test suite copies a published backup into a separate restore
directory and verifies schema, integrity and representative records without
starting another bot or touching live data.

Only regular files with the generated name format and timestamps strictly older
than the configured retention limit are pruned, **after** a new verified backup.
Manual backups, subdirectories, unrelated files and incomplete `.partial` files
from a crash are never pruned automatically. Failed attempts clean their own
incomplete files; leftover crash files require manual inspection. Failures are
logged and retried on the next daily pass. Overlapping runs are coalesced, and
shutdown waits for an active backup before closing SQLite.

**Operations → Database backups** shows enabled/running state, last verification
time and age, size, next scheduled run and explicit backup/retention failures.
Verification metadata is persisted in SQLite across restarts; it records the
last verification, not a guarantee that someone has not since moved/deleted a
backup. No paths, credentials or raw errors are exposed by the API.

These are database-only, unencrypted backups: WhatsApp auth still needs the
controlled full-data backup described above. Keep an off-device copy if host
disk failure must be recoverable. Old pre-cleanup data remains sensitive in
backups until those backups expire. To test recovery manually, copy a backup to
an isolated directory and open it with a raw SQLite client for integrity/schema
checks, never the application's migrating opener. For an actual restore, stop
the bot, preserve the current data first, restore a matching-version database
with its auth files and remove only obsolete live WAL/SHM sidecars while stopped.
Never connect two bot instances with the same WhatsApp credentials.

### Repeatable Isolated Restore Verification

Build the backend once, then pass the **absolute path to a completed standalone
database backup**. In PowerShell, from the repository root:

```powershell
npm --prefix bot-core run build
if ($LASTEXITCODE -eq 0) {
  npm --prefix bot-core run backup:verify -- "C:\Backups\whatsapp_bot\automatic\bot-auto-<timestamp>-<uuid>.db"
}
```

Use `npm --prefix bot-core run backup:verify -- --help` for usage. Relative paths
are relative to the backend package, not necessarily your invoking shell.
For JSON-only output (without npm's script banner), run the built CLI directly:

```powershell
node .\bot-core\dist\cli\verify-backup.js "C:\Backups\whatsapp_bot\automatic\bot-auto-<timestamp>-<uuid>.db"
```

The command copies the source into a new `bot-restore-check-*` directory under
the operating system temporary directory, with owner-only directory/file modes
where supported. Secure that location with Windows ACLs or equivalent too. It:

1. Rejects missing, directory, symlink and `.partial` inputs, and any source with
   a `-wal`, `-shm` or `-journal` sidecar. Do not delete source sidecars to bypass
   this check: obtain a proper standalone online backup instead.
2. Hashes the source and isolated copy and checks source hashes again during
   verification. A moving/changing source is not certified.
3. Opens **only the temporary copy** with raw read-only SQLite, checks structural
   integrity and foreign keys, and requires the current application schema
   version, required tables/columns/indexes and declared foreign-key structure.
4. Reports counts for every application table (including reminders, tells,
   outbox, pets, attempt history and audit records), file size and SHA-256.
   Counts can legitimately be zero. No row contents, paths, identities,
   credentials or raw SQLite/OS errors appear in the report.
5. Closes SQLite and deletes only its own temporary database/sidecars/directory
   before reporting success. Cleanup failure returns a failure, not a pass.

Exit codes are **0** for a verified backup (or help), **1** for verification or
cleanup failure, and **2** for invalid CLI arguments. Failures are controlled
JSON on stderr; successful verification is JSON on stdout. No bot runtime is
imported: no WhatsApp connection, HTTP API, auth reads, delivery workers,
retention jobs, source writes or migrations of the restored database run.
An expected-schema reference is created in memory only. Runtime `DB_PATH`,
`AUTH_DIR` and API settings are not used.

Use a matching application release for an older/newer backup; the command fails
closed on schema mismatch rather than migrating it. This checks database
recoverability at verification time, not message correctness, off-device
availability, auth validity, inference service readiness or a complete system
recovery. A syntactically compatible database can still contain incorrect
business data. Record the backup hash, application commit/image and verification
time securely outside Git. Normal backup retention still governs old snapshots.

For a production-image check without network access, credentials or live-data
mounts, use `docker run`, **not** a second Compose bot instance:

```powershell
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=512m `
  --mount "type=bind,source=C:\Backups\whatsapp_bot\automatic,target=/input,readonly" `
  --entrypoint node whatsapp_bot-bot-core `
  dist/cli/verify-backup.js "/input/bot-auto-<timestamp>-<uuid>.db"
```

Use an image built from this release (or `docker compose build bot-core` first).
Mount only the selected backup directory read-only, never `data` or `auth`.
Provide sufficient temporary space for the database copy; adjust the tmpfs
limit for large databases. The command does not update Operations backup status
or the administrative audit trail.

### Disaster-Recovery Runbook

1. **Prepare and identify the recovery set.** Keep off-device copies of a
   verified standalone database, a separately secured WhatsApp `auth` snapshot,
   local environment/secrets, the matching application commit or image, and any
   required custom ComfyUI assets/models/workflows. Database-only automatic
   backups do not contain these other dependencies. Never put recovery data
   or credentials in Git.
2. **Rehearse offline first.** Run the isolated verifier above against the
   selected backup using matching code. Compare its aggregate counts and hash
   against the intended recovery point. Do not start WhatsApp or delivery
   workers during the rehearsal.
3. **Stop the active instance and prevent competing starts.** Stop the
   dashboard and backend (`docker compose stop web bot-core`), and ensure no
   other host or process uses the same WhatsApp credentials. Do not use
   `docker compose down -v`. Preserve a separate full copy of the current
   stopped `data` directory, including auth and any WAL/SHM/journal files,
   before replacing anything.
4. **Stage recovery outside the live directory.** Restore the verified
   standalone database as `bot.db` and the chosen `auth` snapshot into a
   separate protected staging directory. Keep recovery snapshots unmodified.
   Check file ownership/access, environment/secrets, backup mount and the
   matching backend image. Do not mix a standalone restored database with
   stale live WAL/SHM files; quarantine the entire old stopped data set, then
   activate the staged directory at the configured data bind location.
   Do not remove sidecars from the preserved original snapshot.
5. **Understand replay before starting.** Restoring rewinds application state:
   reminders/tells and pending or expired-lease outbox rows may send again,
   even if WhatsApp received them after the recovery point. The isolated
   verifier never claims or sends them, but a normal backend does. There is
   no delivery-disabled restore startup mode. Review the recovery point and
   accept duplicate/replay risk before starting; never blindly retry failures.
6. **Start exactly one matching backend.** If deliberately upgrading an older
   recovery set, verify it first with matching old code, then take another
   backup and follow the documented migration/reset policy before using new
   code. Older binaries reject newer schemas; image rollback alone cannot
   undo a database migration.
7. **Validate recovery before normal use.** Check container health, WhatsApp
   connection (re-pair only if the restored session is invalid), database
   integrity/foreign keys, expected aggregate counts, protected pet state,
   queue status, service diagnostics and a fresh verified backup. Then start
   the dashboard. Confirm the backup/auth/off-device procedures remain valid.
   Do not test delivery recovery by replaying real failed messages.
8. **If validation fails, stop again.** Preserve the failed recovery state
   separately and return to the saved pre-restore data plus matching image,
   or select another verified recovery point. Never run the old and restored
   bot concurrently. Record recovery decisions outside Git without messages
   or secrets.

## Paint Models

`bot.paint <prompt>` generates a still image with the configured default
checkpoint. Select a local model with `bot.paint sdxl <prompt>`,
`bot.paint flux <prompt>`, `bot.paint hunyuan <prompt>` (Hunyuan DiT 1.2),
or `bot.paint pony <prompt>` (Pony Diffusion V6 XL). `model=pony` also works.
For other compatible checkpoints, use `bot.paint model=filename.safetensors <prompt>`;
quote filenames containing spaces. SD1.5/SDXL checkpoints use the
standard workflow, while the configured Flux checkpoint uses a Flux workflow.
Arbitrary model architectures are not interchangeable with these checkpoints.

Reply to a photo, or caption a photo, with the same command to modify it.
Explicit model selections use that checkpoint for image-to-image generation.
`d=0.7` controls denoising: higher values change the source more. Without a model
selector, photo edits use Flux Kontext; `hard` instead uses the default checkpoint
at stronger denoising. `pixelate p=24` remains a deterministic filter.

Paint is local-only. The installed Wan video models do not provide a verified
still-image paint workflow, so `wan` returns an unsupported-model message for
both text and photos. No paid Wan partner API is called, and no other model is
silently substituted. Video generation uses `bot.film`; it is intentionally
separate from `bot.paint`.

## Film Models

`bot.film <prompt>` generates a short local video with Wan 2.2 image-to-video
nodes and local ComfyUI `SaveVideo` output (mp4/h264). `bot.film minimax <prompt>`
switches to a local MiniMax H3 workflow using `minimax_h3_fl2va_pruned_int8_convrot.safetensors`.
You can also use `bot.film model=minimax <prompt>`.

Replying to a photo with `bot.film <prompt>` anchors the first frame to that
image for both Wan and MiniMax workflows. Output clips are sent back as videos
in WhatsApp.

Required local files for MiniMax mode:

| Resource | Folder under ComfyUI models | Filename |
| --- | --- | --- |
| MiniMax H3 UNet | diffusion_models | minimax_h3_fl2va_pruned_int8_convrot.safetensors |
| MiniMax H3 text encoder | text_encoders | qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors |
| MiniMax H3 video VAE | vae | minimax_h3_video_vae_fp16.safetensors |

These workflows are local-only and do not call cloud partner APIs.

Local smoke checks cover RealVisXL, Hunyuan DiT 1.2, DreamShaper 8,
Juggernaut XL Lightning, Pony Diffusion XL, and Flux, using text and source images.
Sampling steps, resolution, and CFG still need tuning for each checkpoint;
successful execution does not guarantee good results at arbitrary settings.

### Amanesse Illustration Preset

`bot.paint amanesse <prompt>` (or `bot.paint model=amanesse <prompt>`) uses the
local resource stack from [Civitai image 143239787](https://civitai.com/images/143239787).
It also works when replying to or captioning a photo, for example
`bot.paint amanesse autumn colors and red roofs d=0.5`.

The preset uses these exact Civitai versions and ComfyUI filenames:

| Resource | Version ID | Folder under ComfyUI models | Filename | Strength |
| --- | --- | --- | --- | --- |
| Amanesse Works v2.0 | 2414241 | checkpoints | amanesseWorks_v20.safetensors | Base model |
| 96YOTTEA WAI | 1082928 | loras | 96YOTTEA-WAI.safetensors | 0.5 |
| Rapscallion Illustrious | 1169143 | loras | Rapscallion_Illustrious.safetensors | 0.1 |
| People's Works v8 Illus v2 stable | 2034730 | loras | ppw_v8_Illuv2stable_128.safetensors | 0.4 |
| Venus Body ILXL v2 | 2244224 | loras | venus_body_ILXL_v2.safetensors | 2.5 |
| Niji illustrious v3.0 | 2336579 | loras | niji_and_midj_mix217.safetensors | 0.4 |

All six installed files were SHA256-verified against the published versions.
Both model and CLIP LoRA strengths use the values above. The preset fixes
DPM++ 2M / Karras, 30 steps, CFG 7, CLIP skip 2, and the reference negative
prompt; text generation uses 832x1216. It adds the `Rapscallionstyle` trigger
unless already present, retaining your own prompt and generating a fresh seed.
These settings do not modify the dashboard's saved defaults.

Photo edits keep the source dimensions (subject to VAE alignment) and use the
configured denoise unless `d=` or `hard` overrides it. This is an img2img
adaptation, not the reference's original text-only workflow: stronger denoising
can change identity and composition. Pixelation remains a separate filter.
Selecting the raw checkpoint filename does not apply the five-LoRA preset.
Missing resources cause generation to fail rather than use another model.
Both text generation and photo editing were tested locally at full preset settings;
identical results to the Civitai reference are not guaranteed.

### Retro Anime Style Preset

`bot.paint retroanime <prompt>` (or `bot.paint model=retroanime <prompt>`) uses
the local style stack from [Civitai image 142849835](https://civitai.com/images/142849835).
Reply to or caption a photo with the same selector to repaint it, for example
`bot.paint retroanime snowy mountain village d=0.6`.

| Resource | Version ID | Folder under ComfyUI models | Filename | Strength |
| --- | --- | --- | --- | --- |
| lyh_anime kor-il01 (Flux.1 D) | 990743 | checkpoints | lyhAnime_korIl01.safetensors | Base model |
| Retro Anime Flux Style v1.0 | 806265 | loras | RetroAnimeFluxV1.safetensors | 0.45 |
| RandomMaxx Artistify v1.0M | 1075587 | loras | RM_Artistify_v1.0M.safetensors | 0.65 |
| Retro Anime and Comic Vibrant Colors v1.0 | 1191560 | loras | Classic_Anime_Colors.safetensors | 0.4 |

All four installed files were SHA256-verified against the published versions.
The diffusion-only checkpoint uses separate `text_encoders/clip_l.safetensors`,
`text_encoders/t5xxl_fp16.safetensors`, and `vae/ae.safetensors`.
Both model and CLIP LoRA strengths use the values above.

Text generation fixes 672x1200, Euler / Beta, 20 steps, CFG 1, and Flux guidance
3.5. The preset wraps your prompt with anime style descriptors and adds the
`CAICO` trigger unless already present, using a fresh seed. It encodes the
reference negative prompt: `photo, deformed, black and white, realism,
disfigured, low contrast`. At CFG 1 this does not provide traditional negative
guidance. Inline `g=` and dashboard sampling defaults do not override preset
settings; saved dashboard configuration is unchanged.

Photo edits use this same model and LoRA stack with the source latent, keeping
source dimensions subject to VAE alignment. Denoising uses the configured value,
or an explicit `d=` / `hard` override. This img2img adaptation can preserve
unwanted source details at low denoising or change identity at high denoising;
it is not an instruction-tuned editor. Pixelation remains a separate filter.

This is the **style-only** recipe: it does not include the reference's 1.35x
hi-res pass, 4x-AnimeSharp upscaler, alternate hi-res prompt, or ADetailer passes.
Selecting the raw checkpoint filename does not activate this preset. Missing
resources fail generation rather than substitute another model. Full-setting
text and image-edit renders were tested locally; matching the reference image
exactly is not guaranteed.

## Development And Checks

### Adding Or Updating Commands

The typed command catalogue in `bot-core/src/router/commands.ts` owns stable
command IDs, default aliases, descriptions, usage arguments and execution policy.
Implement each ID in `bot-core/src/handlers/commands/index.ts`; TypeScript checks
that the handler registry covers the catalogue exactly. Mark slow AI/media
commands as `background` so every configured alias uses the bounded job queue.
Media-kind handlers and passive matchers are registered separately.

Default configuration and `bot.help` are derived from the catalogue. Help uses
the saved alias-to-ID mapping, so renamed aliases retain their descriptions and
show the configured alias in usage examples. Existing suffix-based variants
remain unchanged: `.raw` for unpersonalised ask and `.neg` for harsher roast.
Keep those suffixes when renaming those variants. Unknown saved command IDs
remain visible as bare help entries and produce registration warnings; they
do not execute.

Saved mappings are not replaced by catalogue defaults. When adding default
aliases for existing installations, bump `CONFIG_VERSION` in
`bot-core/src/state/repos.ts` to trigger the existing additive backfill.
Update catalogue compatibility tests when intentionally changing defaults.

### Running Checks

Use Node 22. In both `bot-core` and `web`, run `npm ci`.

```text
npm --prefix bot-core run typecheck
npm --prefix bot-core run lint
npm --prefix bot-core test
npm --prefix bot-core run build
npm --prefix web test
npm --prefix web run build
```

### Shared API Contracts

`shared/api.d.ts` contains the dependency-free, type-only wire contracts used by
both applications. Existing backend and dashboard import locations re-export
these types for compatibility. Keep database rows and transport-specific objects
out of this file; only JSON payloads and client snapshots belong here.

Configuration and pet-setting schemas are checked against the shared contracts
for field names and output types. API response builders also check their DTOs
against the contracts. Runtime validation remains on the backend; these shared
types do not validate untrusted JSON in the browser or change any response shape.
Configuration revisions still travel in ETag headers, while pet revisions are
included in their response bodies.

Both application Docker builds now use the repository root as their context so
they can read `shared/`. Compose already supplies the correct context. For a
standalone build, run `docker build -f bot-core/Dockerfile .` or
`docker build -f web/Dockerfile .` from the repository root. The root
`.dockerignore` allowlists build inputs and excludes local credentials, data,
dependencies and generated output. Runtime images do not need the declarations.

Set `API_TOKEN` for normal backend development. `ALLOW_INSECURE_API=true` is an
explicit local-only escape hatch and binds the API to 127.0.0.1. The dashboard
dev server proxies to `BOT_CORE_URL` (default http://localhost:5000).

The ComfyUI base image and source revision, plus the working Torch/torchvision
nightly pair, are pinned in its Dockerfile. The one-day-offset torchvision
dependency override is intentional for that exact tested pair, not a general
ABI guarantee. Python requirements and OS repositories are not fully locked;
archive tested image digests and wheel artifacts for long-term reproducibility.
Validate image generation on the target GPU before rolling out a rebuilt image.