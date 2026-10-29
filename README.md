# Kids Studio

Personal AI-assisted YouTube Kids content production dashboard.

**Current milestone (3):** dashboard, **Idea Discovery**, the AI-powered **Story Workshop**, the **Production Studio** (scene plans, Higgsfield generation, asset review) and the **Characters** library are functional. Playlists, Publishing, Analytics and Advertising Budget have placeholder pages only. There are no YouTube or advertising integrations, nothing is ever published automatically, and no advertising money is spent.

**Stack:** Next.js 16 (App Router, Cache Components) · TypeScript · Tailwind CSS 4 · shadcn/ui · PostgreSQL 17 (Docker) · Drizzle ORM · Zod · Anthropic TypeScript SDK · Vitest

## Getting started

Requires Node.js 22+ and Docker Desktop.

```powershell
npm install
Copy-Item .env.example .env.local   # if .env.local doesn't exist yet
npm run db:up                       # start Postgres on localhost:5440
npm run db:migrate                  # apply migrations (includes Story Workshop and Production Studio tables)
npm run dev                         # http://localhost:3000
```

### Claude API setup (Story Workshop)

Story generation calls the Anthropic Messages API from the server only. Without a key the Story
Workshop still works for writing and editing briefs; the Generate buttons are disabled and the
page explains what's missing.

1. Create an API key at <https://console.anthropic.com/settings/keys>.
2. Put it in `.env.local` (never in `.env.example`, never with a `NEXT_PUBLIC_` prefix):

   ```dotenv
   ANTHROPIC_API_KEY=sk-ant-...
   # Optional:
   # ANTHROPIC_MODEL=claude-opus-5-5     # default
   # ANTHROPIC_EFFORT=medium             # low | medium | high | xhigh | max
   ```

3. Restart `npm run dev`. **Settings → Workspace** and the Story Workshop page show the API as
   configured once the key is picked up.

`.env*` files are git-ignored except `.env.example`. The key is read only in
`src/server/ai/claude.ts`, which imports `server-only`, so importing it from a client component
fails the build.

To explore with demo content, click **Load sample ideas** on the empty Idea Discovery page or in **Settings**.

Production build: `npm run build` then `npm run start`.

## Features in this milestone

| Area | Status |
| --- | --- |
| Dashboard | Total ideas, stories in progress, videos in production, published videos, production pipeline, recent projects, quick actions |
| Idea Discovery | Create, edit, delete, change status; search (title, description, tags); filters for workflow status, category, age range, priority and originality review; filters live in the URL; **Start story** from any idea's menu |
| Story Workshop | Briefs from an idea or from scratch; Claude generation, revision with notes and fresh versions; editable preview; revision history with restore; manual approval; token usage and cost estimates |
| Production Studio | Production plans from approved stories; scene editing and reordering; per-scene status; Higgsfield API generation with polling, retries and timeouts; manual generate-and-import workflow; asset review and final selection; progress and cost estimates; ready-for-assembly gate |
| Characters | Reusable character library with consistent visual descriptions, reference images, approval for reuse, appearances across stories |
| Asset library | All scene images and clips with preview, provider, model, date, duration, size, file location and review status; filters in the URL |
| Settings | Load / remove sample data, workspace info, Higgsfield and media folder status |
| Other modules | Placeholder pages describing the planned scope |

Each idea stores: title, description, category, target age range, source URL, originality review status, priority, workflow status, format, tags, notes, and YouTube compliance flags (`madeForKids`, `containsSyntheticMedia`).

**How dashboard metrics are derived.**

- Stories in progress = Story Workshop stories that are *Brief only* or *In review*
- Videos in production = ideas in `scripted` + `generated` (idea status; per-scene production progress is on the Production Studio pages)
- Published videos = ideas in `published`

## Story Workshop

1. **Brief** (`/stories/new`). Pick an idea to pre-fill the title, age range, topic, duration and
   notes, or start from scratch. Fields: title, target age range, topic, learning objective, main
   characters (optional: Claude invents them), duration, tone, visual style, language and extra
   notes. Validated with Zod on the server and with native checks in the browser.
2. **Generate** (`/stories/[id]`). Claude returns one structured document: title and premise;
   beginning, middle and ending; full narration; characters with fixed visual descriptions; a
   scene-by-scene storyboard (setting, action, narration, dialogue, characters, visual prompt,
   sound effects, music mood, seconds); overall music mood; estimated duration; and a review
   checklist for age-appropriateness and originality. Generation usually takes 1–3 minutes, and
   the page shows a progress card with the elapsed time.
3. **Review and edit.** Every field is editable. *Save revision* stores your edits as a new
   revision. *Revise with notes* sends the current draft and your notes to Claude. *Write a new
   version* asks for a different take. Nothing is overwritten: every change is a revision, and
   any revision can be restored.
4. **Approve.** Approval is manual and requires ticking that you've read the story. It marks the
   story *Approved for production* and moves a linked idea that is in Draft or Approved to
   *Scripted*. Editing or regenerating afterwards sends the story back to review. Approval does
   not publish anything.

Claude's checklist is a self-review and is only advisory. Originality and safety remain your call.

### How the Claude call works

- Model `claude-opus-5-5` by default, effort `medium` (override with `ANTHROPIC_MODEL` and
  `ANTHROPIC_EFFORT`).
- Streaming request (`client.beta.messages.stream`) with structured output built from the Zod
  schema in `src/lib/stories.ts`, so the response is validated before it is saved.
- Server-side refusal fallback (`fallbacks: "default"`) is on. If the model declines for policy
  reasons, the API retries on its default fallback model. A final refusal or a truncated output
  is shown as a clear error.
- The SDK retries rate limits, 5xx and overload errors twice. Remaining failures are mapped to
  specific messages (bad key, unknown model, rate limit, network, outage).

### Usage and cost

Every API call is logged in `story_generations`, including failed calls that still used tokens.
The story page shows call count, input and output tokens, and the most recent calls. The Story
Workshop index shows workspace totals.

Costs are **estimates**: token counts reported by the API multiplied by the list prices in
`src/lib/ai-usage.ts` (as of October 2026). Models without a known price show tokens only. Your
actual bill is in the Anthropic Console.

### Data

| Table | Contents |
| --- | --- |
| `stories` | Brief, status, current content (JSON), optional link to an idea |
| `story_revisions` | Every version (generated, regenerated, edited or restored) with revision notes |
| `story_generations` | Every Claude call: model, tokens, duration, error |

Deleting a story removes its revisions and usage log. Deleting an idea keeps its stories.

### Sample data

The 10 demo ideas in `src/lib/sample-ideas.ts` are fictional. They are stored with `is_sample = true`, shown with a **Sample** badge, and can be removed in one click from Settings without touching your own ideas.

## Production Studio

### Workflow

1. **Approve a story** in the Story Workshop.
2. **Create a production plan** (`/production` → *New production plan*). Only approved stories
   can be picked. The plan imports every scene (title, setting, action, narration, dialogue,
   duration, visual prompt) in storyboard order, adds a default negative prompt, and links the
   story's characters. A character whose name matches one in the library (case-insensitive) is
   reused, preferring approved ones. Otherwise it's added to the library as a draft. The story
   itself isn't changed, and later story edits are **not** synced into the plan.
3. **Edit scenes** (`/production/[plan]/scenes/[scene]`): title, narration, dialogue, duration,
   setting, action, linked characters, visual prompt, negative prompt and notes. Reorder scenes with
   the arrows on the plan page; add or delete scenes.
4. **Generate**, automatically through the Higgsfield API or manually in the Higgsfield web app (see
   below). The prompt that's sent or copied is the scene's visual prompt plus each linked
   character's library description ("Keep these characters exactly consistent: …") plus the plan's
   visual style if the prompt doesn't mention it.
5. **Review** each asset: tick the confirmation, then *Approve* or *Reject* (with optional notes).
   Only approved assets can be chosen with *Use as final*. Rejecting or un-approving the final asset
   clears it. *Replace with new revision* imports a newer version and keeps the original.
6. **Mark ready for assembly** on the plan page once every scene has an approved final asset. This
   requires a confirmation and only changes the plan status. Nothing is rendered, uploaded or published.

### Scene status

Derived from the scene's jobs and assets (`deriveSceneStatus` in `src/lib/production.ts`) after
every change:

| Status | Meaning |
| --- | --- |
| Needs prompt | No visual prompt yet |
| Ready to generate | Prompt present, nothing in flight |
| Generating | An API job is queued or running, or a manual job is waiting for its import |
| Needs review | At least one asset is waiting for review |
| Failed | The latest job failed, was blocked by moderation or timed out. The error is shown on the scene |
| Approved | The scene has an approved final asset |

### Higgsfield integration

Built only on Higgsfield's published API (<https://docs.higgsfield.ai>, OpenAPI spec checked
October 2026). No endpoint is guessed, and a job is marked completed only when Higgsfield returns
output files.

**Integrated through the API (needs `HF_API_KEY_ID` and `HF_API_KEY_SECRET`):**

| Operation | Endpoint |
| --- | --- |
| Submit a generation | `POST /{model path}` with `Authorization: Key id:secret` and an `Idempotency-Key` |
| Poll status | `GET /requests/{id}/status` (queued → in_progress → completed / failed / nsfw / canceled) |
| Cancel a queued request | `POST /requests/{id}/cancel` |
| Upload a start image for image-to-video | `POST /files/generate-upload-url`, then `PUT` to the presigned URL |
| Cost estimate before submission | `POST /estimate/{model path}` → `{ usd }` |

Models (`src/lib/higgsfield.ts`), with only documented body fields:

- Images: Soul (`/higgsfield-ai/soul/standard`, with aspect ratio and 1–4 variations) and Soul V2
  (`/higgsfield-ai/soul/v2/standard`, prompt only).
- Video: Seedance 2.5 image-to-video and text-to-video (`/bytedance/seedance-2.5/...`, any length
  from 4 to 30 s, 1080p, generated audio off because narration and music are produced separately),
  Kling 2.5 Turbo Pro/Standard image-to-video and Pro text-to-video (5 or 10 s, negative prompt
  supported), and Hailuo 2.3 Standard image-to-video and text-to-video (6 or 10 s).
- GPT Image isn't available: Higgsfield's API catalog has no GPT Image endpoint. It's only mentioned
  as the renderer behind Ads Studio. Use it in the Higgsfield web app and import the result.

How jobs are handled:

- **Submission:** the request body, model, prompt and estimate are stored before submitting.
  Network errors, 5xx and 429 (honouring `Retry-After`) are retried up to 3 times with the same
  idempotency key, so a retry can't create a duplicate generation. 401/403/422 errors get specific
  messages and aren't retried.
- **Asynchronous completion:** while a plan or scene page is open, the browser asks the server to
  poll active jobs every 5 s, backing off to 30 s when nothing changes. On completion the output
  files are downloaded to the media folder, because Higgsfield deletes outputs after 7 days, and
  saved as assets that need review. If a download fails, the asset keeps the provider URL and shows
  when it expires.
- **Failures:** `failed` and `nsfw` results are recorded with their error. Higgsfield doesn't charge
  for them.
- **Timeouts:** a job still queued or running after 30 minutes is marked *Timed out*. A queued one is
  canceled, which refunds it. *Check again* polls it once more without the time limit.
- **Retries:** *Retry same request* re-sends the stored request as a new attempt linked to the old
  one. To use an edited prompt, start a new generation instead.
- **Safety gate:** prompts that name well-known franchises, characters or studios, or ask for "in
  the style of" an artist, are blocked from API submission until edited (`findPromptConcerns`). The
  list isn't exhaustive, so human review remains the real safeguard.

**Manual (always available, and the only option without API keys):**

- Copy the prompt and negative prompt, open Higgsfield, generate there, and download the result.
- Optionally press *Start manual image/video job* so the scene shows as generating and the import
  completes that job.
- Import the file (upload, up to 500 MB for video) or a direct https link. Manual work is labelled
  **Manual** with a hand icon everywhere, and API work is labelled **API**.
- **Character references:** with *Grok Image 2.0* (the default image model for new plans), each
  linked character's approved reference image (the primary one when set) is uploaded and sent as
  `image_urls`. The prompt says which image shows which character. Soul has no documented
  reference-image parameter, so with Soul characters are drawn from the text alone and drift between
  scenes. The generation panel warns about linked characters that have no approved reference.

**Not integrated:** webhooks (`hf_webhook`) need a public HTTPS endpoint, and this app runs on
localhost, so it polls instead. There's also no account balance or billing lookup.

#### Setup

1. Create an API key pair at <https://console.higgsfield.ai>. API usage is pay-as-you-go from an
   API balance, separate from a Higgsfield web subscription.
2. Add to `.env.local` (never with a `NEXT_PUBLIC_` prefix):

   ```dotenv
   HF_API_KEY_ID=...
   HF_API_KEY_SECRET=...
   # Optional, default ./storage/media
   # MEDIA_DIR=D:/kids-studio-media
   ```

3. Restart `npm run dev`. The Production Studio and Settings show the API as configured.

The keys are read only in `src/server/providers/higgsfield.ts`, which imports `server-only`.

### Costs

Before each API submission the app asks Higgsfield's estimate endpoint for a USD price and stores
it on the job. The plan page sums estimates for jobs that are or may be charged. Failed, moderated
and canceled jobs are excluded. If Higgsfield returns no estimate for a model, the job shows
"no price estimate" and isn't counted. No prices are hard-coded. Manual jobs use your web-plan
credits and aren't tracked. Your actual bill is in the Higgsfield console.

### Characters

`/characters` holds a reusable character bible: name, role, personality, a **consistent visual
description** (added to every prompt the character appears in), notes, and a status (Draft,
Approved, Archived). Approve a character to signal its look is final, then reuse it in later
episodes. New plans link to existing characters with the same name. Upload reference images
(PNG/JPEG/WebP), approve them, and choose a primary one. Approved references can be the start
frame for image-to-video and are what you upload to Higgsfield manually. The form reminds you to
design original characters, and descriptions are checked for franchise names.

### Assets and storage

- Files live in `MEDIA_DIR` (default `storage/media`, git-ignored): `scenes/<scene id>/` and
  `characters/<character id>/`, with random file names. They're served by `/media/...`, which
  blocks path traversal and supports range requests for video seeking.
- Every asset records its source (Higgsfield API or manual import), provider, model, prompt,
  creation date, duration (from the request for API clips, or read in the browser for uploads),
  size, local path, original URL, per-scene revision number, the revision it replaces, review
  status, notes and request metadata.
- Nothing deletes files. Rejected assets are kept, and deleting a plan, scene or character removes
  the database records but leaves files on disk.
- Uploads go through `POST /api/assets` (a route handler, because server actions cap bodies at
  1 MB). It only accepts same-origin requests.

### Production data

| Table | Contents |
| --- | --- |
| `production_plans` | One per story (kept if the story is deleted): title, style, status, aspect ratio, default models |
| `production_scenes` | Ordered scenes with narration, dialogue, duration, prompts, status, error, final asset |
| `scene_characters` / `story_characters` | Character links |
| `characters` | Character library |
| `generation_jobs` | Every API or manual attempt: model, request, provider request id, estimate, status, error, timings |
| `assets` | Scene images and clips, and character reference images |

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server, bound to 127.0.0.1 |
| `npm run build` / `start` | Production build / serve |
| `npm run typecheck` / `lint` | TypeScript and ESLint |
| `npm test` / `test:watch` | Vitest unit tests (no database or API key needed) |
| `npm run db:up` / `db:down` | Start / stop the Postgres container |
| `npm run db:generate` | Create a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Browse the database in Drizzle Studio |
| `npm run db:psql` | Open a `psql` shell inside the container |

## Layout

```
src/
  app/                   routes: / (dashboard), /ideas, /settings, placeholder modules,
                         error.tsx and not-found.tsx
  components/            app sidebar, page header, module placeholder
  components/ui/         shadcn/ui components
  components/ideas/      idea dialogs, filter bar, row actions, badges, sample-data button
  components/stories/    story brief form, workspace, editor, approval, history, usage
  components/production/ plan and scene UI, generation panel, job list, asset cards, import dialog
  components/characters/ character form and actions
  db/                    Drizzle schema and client
  lib/ideas.ts           shared enums, labels, Zod validation, filter parsing
  lib/stories.ts         story enums, brief and story-content Zod schemas, editor helpers
  lib/ai-usage.ts        token usage totals and cost estimates
  lib/production.ts      production enums, scene status, progress, costs, prompts, safety checks
  lib/higgsfield.ts      documented Higgsfield models and request bodies
  lib/generation-jobs.ts provider status → job update (completion, failure, timeout)
  lib/navigation.ts      module registry (sidebar + placeholder pages)
  lib/sample-ideas.ts    demo data
  server/actions/        server actions (mutations)
  server/queries/        read queries
  server/ai/             Claude client, story generation and prompt (server-only)
  server/providers/      Higgsfield API client (server-only)
  server/production/     job submission, polling, asset records, scene status sync
  server/media/          local media storage
  test/                  test fixtures
drizzle/                 generated SQL migrations (commit these)
```

## Notes and limitations

- **No authentication.** Keep the app on localhost until auth is added to every server action.
- **Single user.** There are no accounts or workspaces yet.
- **Error handling.** If Postgres is not running, data pages show an error with a retry button. Placeholder pages keep working. Mutations report a "could not reach the database" toast.
- **Validation.** Done with Zod on the server (title length, URL format, enum values), plus native browser checks in the form.
- **Originality review** of ideas is a manual status. Stories get Claude's self-review checklist,
  which is advisory. There is no automated similarity check against existing content.
- **Tests** cover validation, prompt building, cost estimates, error mapping and the generation
  flow with a mocked Claude client; scene status, progress, costs, safety checks, story import,
  Higgsfield request bodies, the Higgsfield client (auth, idempotent retries, errors, uploads,
  estimates) with a fake `fetch`, job status interpretation and media storage. They never call a
  real API.
- **Higgsfield polling** only runs while a plan or scene page is open. Close the tab and jobs
  finish on Higgsfield's side; reopen the page (or press *Check now*) to collect them within the
  7-day retention window.
- **No final video assembly yet.** "Ready for assembly" is a reviewed checkpoint; editing,
  voice-over and rendering are later milestones.
- **Long requests.** Generation runs inside a server action and can take a few minutes. That's
  fine locally; a serverless host would need a longer function timeout.
- **Dark theme only.** The app forces dark mode, and the light tokens in `globals.css` are shadcn defaults.
