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
- Database migration version 1 adds the durable outbox; version 2 adds group
  pets and picture-delivery metadata. Both preserve existing configuration,
  contacts, reminders and tells. Back up before upgrading; older binaries
  cannot open a version-2 database.
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
globally. These interactive jobs and trivia/duel games are not durable across
restarts. Group pets, rescue progress and pet deliveries are durable.
Shutdown stops intake, drains accepted work, disposes timers/streams and then
closes SQLite. After 30 seconds the process exits; outbox leases recover later.

Message bodies are no longer logged by incoming-message middleware. Analytics
and delivered outbox rows still contain message text: apply a retention policy
appropriate to your chats and protect backups as sensitive data.

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
disabled, hibernating, offline/on siesta, or when any need is critical.
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
request can be active. Care/number requests default to 30 minutes; silence asks
for two full minutes with no human messages, including owner chatter, media
and commands. Bot output and duplicate deliveries do not count. Silence never
mutes participants or deletes messages.

Request windows start after WhatsApp acknowledges delivery. Unsolicited pet
pictures wait until waking hours, without blocking ordinary reminders.
Failures use the existing durable outbox's retry policy; delivery remains
at-least-once, so an ambiguous acknowledgement can produce a duplicate picture.

When any stat stays critical (20 or below) for 24 active hours, the pet
hibernates. Another 48 active hours of hibernation removes **one** form,
once per neglect episode; the egg cannot devolve further. The pet never dies.
Rescue requires a snack and the displayed dream-riddle, in either order.
Progress is shared and saved; one person can do both steps, and rescue has no
expiry. Revival restores stats to 60 and grants a 24-active-hour grace period.
If it devolved, healthy-time progress resets to the lower form's threshold:
the group must earn the next evolution again.

Pause, disable, removed group approval, WhatsApp disconnects/stale connections,
global bot siesta and process downtime freeze pet time and neglect. Long
scheduler gaps are treated as downtime rather than backfilled. Pause/disable
and removed approval also cancel queued pet notifications and active requests.
An interrupted silence challenge is cancelled without penalty because offline
silence cannot be verified; other delivered request windows freeze and resume
across downtime. Re-enabling keeps the existing pet, not a fresh replacement.

## Backup And Recovery

Stop `bot-core` before copying all of `data/`, including the SQLite WAL/SHM files
if present and the `auth/` directory. Restart after the copy completes. For a
live backup, use SQLite's backup API; copying only an open `bot.db` is unsafe.
Test restoration into a separate directory, without simultaneously connecting
two bot instances with the same WhatsApp credentials. Restore a matching
application/database version; newer database versions fail closed.

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