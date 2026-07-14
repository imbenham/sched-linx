# sched-linx

A prototype scheduling system for healthcare practices, built on top of Donald Knuth's [Dancing Links](https://en.wikipedia.org/wiki/Knuth%27s_Algorithm_X) algorithm. Explores how a single algorithmic substrate — exact cover with color — can flex across a wide range of clinical scheduling contexts without carving out special-case code paths.

## Dancing Links and healthcare scheduling

When I was learning to code, the very first thing I "shipped" was an iOS application that generated Sudoku puzzles. The generation algorithm was a (very green software dev's) implementation of Knuth's *Dancing Links* algorithm for solving exact cover problems. I was fascinated by the way the algorithm could efficiently explore a huge combinatorial search space by cleverly *dancing* rows in and out of a matrix representation of the problem.

Years later, I found myself working on scheduling problems in the healthcare space, and realized that the general shape of those problems was often similar to the exact cover problems Dancing Links solved — it was a matter of selecting the right combination of resources to meet a set of constraints.

Moreover, while the basic scheduling atom is the same — a timeslot needs to be matched to a provider capable of filling that timeslot — the number of additional constraints that can be added on top of that fundamental problem is vast: provider qualifications, patient preferences, equipment availability, room capacity, and more. The possibilities are as varied as the landscape of clinical contexts.

Without a clear framework for extensibility, a scheduling system can be stressed each time a new constraint is added, and its ability to adapt to new contexts can be limited. Core logic may need to be refactored, making the new behavior not only time-consuming to add, but potentially risky if it touches existing functionality that other practices rely on.

That's what really piqued my interest in using Dancing Links as a foundation for a scheduling system: its flexibility in accommodating a wide range of constraints, and its efficiency in navigating complex search spaces. Instead of risky rewrites, what if additional constraints could be folded into the same underlying algorithmic framework, without needing to change the core implementation?

This repo is that idea in prototype form.

## What's in here

- **Scenarios (`/scenarios`)** — five hand-built practice configurations, each surfacing a different constraint pattern (specialty routing, room contention, walk-in capacity, multi-location routing, telehealth-vs-in-person). Each scenario mounts an interactive calendar so you can book, cancel, and watch the constraint landscape shift.
- **Agentic onboarding (`/agentic-onboarding`)** — an LLM-driven conversation that interviews a practice manager about their operations and materializes a working sched-linx scenario from the answers. The assistant records providers, services, rooms, schedules, and pinned slots as it goes, then commits to a live scenario the user can inspect.
- **Admin schedule editor (`/admin/[tag]/schedule`)** — post-commit surface for tuning what the LLM laid down: edit location capacity per day-of-week, edit provider shifts, copy a day's schedule to other days with a destructive-action safeguard.
- **Core scheduling substrate (`src/scheduling/`, `src/dlx.ts`)** — the DLX + XCC implementation and the layer that lifts booking requests into an exact-cover matrix.

## Quick start

Requires Node 20+.

```bash
git clone https://github.com/imbenham/sched-linx.git
cd sched-linx
npm install
cp .env.example .env.local     # fill in ANTHROPIC_API_KEY to enable agentic onboarding
npm run dev
```

Open `http://localhost:3000`. The dev DB (`local-db/`) is created on first run and persists between restarts.

### Common commands

| | |
|---|---|
| `npm run dev` | Start the Next.js dev server. |
| `npm run test` | Run the Vitest suite (78 tests). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run db:generate` | Generate a Drizzle migration after schema changes. |
| `npm run build:refdb` | Build the pre-seeded reference DB used by the deploy. |
| `npm run build` | Chains `build:refdb` then `next build`. |

## Architecture

### Two scheduling paradigms

1. **Provider-scheduled** — a booking is bound to a specific provider whose schedule covers the time. The picker constructs an exact-cover matrix with columns for the booking request, existing pinned bookings, providers, and (when relevant) rooms, then walks candidate rows until one doesn't strand any existing pin.
2. **Location-scheduled** — a booking is bound to a location that has spare capacity for its window. No provider is committed at booking time; capacity is a linear count against overlapping pins. Multi-location scenarios use a pluggable routing strategy (default: most-headroom) when the caller doesn't specify a target location.

Both paradigms share the same `Slot` shape and lifecycle — the substrate distinguishes them only via `service.requiresProvider`.

### Canonical model

`src/model.ts` defines the shared vocabulary: `Location`, `Provider`, `Service`, `ProviderSchedule`, `LocationSchedule`, `Room`, `Slot`, `BookingRequest`, etc. IDs are typed string aliases (`ProviderId`, `LocationId`, ...) — semantic naming without nominal branding.

Time is stored as ISO 8601 UTC strings (the `Instant` alias) to keep serialization cheap and dodge timezone footguns. Display timezone lives per-location and is applied at the UI boundary.

### Tag-based scoping

Every row across the scheduling tables carries a `tag` column. Scenarios use stable base tags (`scenario1`, `scenario2`, ...); visitors on the deployed site get their tags prefixed with a per-cookie UUID (`v-<uuid>-scenario1`) so one visitor's mutations don't leak into another's view. Pre-seeded agentic sessions keep their global `agentic-<id>` tag so everyone sees the same demo transcripts.

### DB

Uses [pglite](https://pglite.dev) — Postgres compiled to WASM — with [Drizzle](https://orm.drizzle.team) as the ORM. No Docker, no external server. Dev uses a file-backed pglite at `./local-db`; the Vercel deploy uses `/tmp/sched-linx-db` hydrated from a bundled reference DB on cold start.

Schema lives in `src/db/schema.ts`. Migrations are generated with `npm run db:generate` and applied automatically at bootstrap.

## Agentic onboarding

`app/_actions/agentic.ts` drives the conversation. Anthropic's Claude gets a system prompt describing the substrate + a set of tools (`add_location`, `add_service`, `add_provider_schedule`, `add_pinned_slot`, `flag_unsupported`, `finalize_plan`, etc.). Each turn is a tool-loop: model → tool_use blocks → executor mutates a staging `SeedPlan` → tool_result → model responds.

`SeedPlan` is a JSONB staging area on the `agentic_setups` row. The user hits **Commit scenario** and the plan is promoted into the scoped scheduling tables in one transaction; from that moment the calendar can render it.

Replay mode on the session detail page walks the persisted dialog turn-by-turn with a "thinking..." beat between user + assistant, making transcripts feel live for demos.

## Deploying (Vercel)

Environment variables (set in the Vercel dashboard, not committed):

| Var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | No, on read-only deploys | Anthropic SDK. Safe to omit when `NEXT_PUBLIC_AGENTIC_READONLY=1` — the SDK is lazy-initialized only when `sendUserMessage` runs, and that action is blocked in read-only mode. |
| `ANTHROPIC_MODEL` | No | Model override. Defaults to `claude-sonnet-4-6`. |
| `NEXT_PUBLIC_AGENTIC_READONLY` | On public deploy | Set to `1` to disable `createSetup`, `sendUserMessage`, `updateSetupTitle`, `commitSetup`. Visitors can still view + replay pre-seeded transcripts. Shows a "Fork on GitHub" banner. |
| `NEXT_PUBLIC_GITHUB_URL` | No | URL the read-only banner points to. Defaults to `https://github.com/imbenham/sched-linx`. |

### Pre-seeded reference DB

`npm run build:refdb` creates `./ref-db/` from every `.json` file in `.data/`. Each fixture is a full export of an agentic setup (dialog + committed scenario) — produced by the **Export ↓** button on the `/agentic-onboarding` list page. Commit the JSON files; `ref-db/` is `.gitignore`d (regenerated on every build).

`npm run build` chains `build:refdb` before `next build`, and `next.config.mjs` bundles `ref-db/` into the function output via `outputFileTracingIncludes`. On cold start, `src/db/client.ts` copies the bundled dir into `/tmp/sched-linx-db` — visitors land on a DB pre-loaded with the demo transcripts.

## Tests

```bash
npm run test
```

Currently 78 tests, mostly focused on scheduling correctness: `pickSlot` picks the right cell across provider/location paths, `proposeReshuffle` finds valid reshuffles when the direct pick fails, `applyReshuffle` writes them cleanly, room-constrained cell state renders correctly, etc.

## Tech stack

- **Framework:** Next.js 16 (App Router), React 19, server actions
- **Data:** Drizzle ORM + pglite (embedded WASM Postgres)
- **Algorithm:** custom DLX + XCC in TypeScript (`src/dlx.ts`, `src/scheduling/`)
- **LLM:** Anthropic SDK v0.107, Claude Sonnet by default
- **UI:** Tailwind v4, `react-markdown` + `remark-gfm` for chat rendering
- **Testing:** Vitest

## License

TBD.
