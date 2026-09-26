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
silently substituted. Video generation is outside `bot.paint`; `bot.film` is not
implemented yet. MiniMax is not integrated.

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