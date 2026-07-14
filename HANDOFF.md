# sched-linx — Handoff Notes

**For a Claude instance picking this up cold.** Read this first; it explains what this project is, where it sits, what's been built, and what's next. Then look at `src/dlx.ts` for the algorithm core, `src/model.ts` for the canonical data model, and `src/scheduling/` for the matrix-building and query layers.

---

## What this project is

A prototype scheduling application built on Knuth's **Dancing Links (DLX) with Algorithm X + XCC** as its algorithmic foundation. The eventual goal is a working end-to-end backend (Express + PostgreSQL) where the scheduling decisions — feasibility checks, picking which provider gets a slot, optional reshuffling, optional multi-objective scoring — all flow through a single DLX matrix instead of being scattered across multiple algorithms.

The scheduling domain model is **canonical, not FHIR**. The project intentionally defines its own resources rather than inheriting FHIR's shape. This is a clean-room exploration: what does scheduling look like when DLX is the foundation from day one and the data model is designed around the algorithm rather than around healthcare-interoperability standards. The canonical model is intentionally smaller than FHIR's — e.g., no separate Patient or Appointment resources; the Slot IS the booking — and the vendor integration layer compresses FHIR shapes to canonical at the adapter boundary.

**Status: in active development.** DLX core, canonical data model, candidate-slot generation, matrix builder, Q2 picker, Q3 reshuffle, the persistence layer, scheduling server actions, and a basic visualizer page are all in place. 61 tests across 11 files, all passing; `npm run build` is clean. No real-EHR integration yet.

**Recent model collapse (2026-06-07):** Patient and Appointment tables/types were dropped; the persisted Slot IS the booking. `Slot` gained a `status` field (`free | busy | canceled` — FHIR-aligned vocabulary, with `canceled` mapping to FHIR's `entered-in-error` at the integration boundary). Reshuffle apply uses cancel-old + create-new (status='canceled' on the source, new busy slot for the new provider) so append-only history is preserved via the status column. `AppointmentRequest` → `BookingRequest` (no `patientId`). Bookings are anonymous at the canonical layer; patient identity reattaches at the vendor integration boundary. See the [[pinned-appointment-stability]] memory for the terminology note.

**HTTP framework:** the user pivoted from Express to Next.js. The pure modules (`src/dlx.ts`, `src/model.ts`, `src/scheduling/*`, `src/db/*`) are framework-agnostic by design — Next route handlers and server actions call into them the same way Express would have. The visualizer page (`/visualizer`) is the active UI surface.

## Why DLX, in one paragraph

Scheduling presents several related-but-distinct algorithmic questions: *can this candidate slot fit?* (feasibility), *which provider should take this slot when multiple qualify?* (picker), *would moving existing tentative assignments unlock this candidate?* (anonymous reshuffle), *across all feasible arrangements, which is best by some metric?* (multi-objective scoring). Most scheduling systems answer these with separate algorithms layered on top of each other. DLX answers all four with one data structure and different queries against it — feasibility is "find one cover," picker is "tentatively cover a row, count consequences, restore," reshuffle is "find a different cover that includes the new candidate," multi-objective is "enumerate covers and score." The S-heuristic (smallest column first) makes the search efficient. The dance — `L[R[x]] = R[x]; R[L[x]] = x` removes a node and the symmetric undo `L[R[x]] = x; R[L[x]] = x` restores it in O(1) because removed nodes retain pointers to their old neighbors — makes backtracking cheap, which is what lets the algorithm explore large search spaces.

---

## Current state

```
sched-linx/
├── HANDOFF.md                              ← this document
├── .gitignore                              node_modules, .next, local-db, .env*, etc.
├── package.json                            TS + ESM. Scripts: dev, build, start, test, test:watch, typecheck, db:generate.
├── tsconfig.json                           Strict, ES2022, Bundler resolution, jsx: react-jsx, next plugin, `@/*` path alias.
├── next.config.mjs                         Next.js config (App Router; pglite marked as serverExternalPackage).
├── postcss.config.mjs                      PostCSS pipeline — Tailwind v4 plugin.
├── drizzle.config.ts                       drizzle-kit config (postgresql dialect, schema → drizzle/).
├── drizzle/                                Generated migration SQL — produced by `npm run db:generate`.
├── app/
│   ├── layout.tsx                          Root layout — html shell + sidebar Navbar.
│   ├── page.tsx                            Root page at `/`.
│   ├── globals.css                         `@import "tailwindcss"` — Tailwind v4 entry point.
│   ├── _actions/
│   │   └── scheduling.ts                   Server actions: scheduleAppointmentAction, applyReshuffleAction, resetScenarioAction.
│   ├── visualizer/
│   │   └── page.tsx                        Visualizer page (placeholder; Phase C pending).
│   └── api/
│       └── health/
│           └── route.ts                    Smoke endpoint — GET → { status: 'ok' }.
├── components/                             Shared React components (currently empty; @/components/ alias).
├── src/
│   ├── dlx.ts                              ~300 lines. DLX core (see below).
│   ├── model.ts                            Canonical data model — branded IDs + entities.
│   ├── printMatrix.ts                      ASCII Matrix visualization for debugging.
│   ├── db/
│   │   ├── schema.ts                       Drizzle table definitions mirroring src/model.ts.
│   │   ├── client.ts                       pglite-backed Drizzle client factory + migrator + HMR-safe singleton.
│   │   ├── repository.ts                   Load + apply bridge between Drizzle rows and canonical types.
│   │   └── seed.ts                         Destructive scenario seeder for dev + visualizer.
│   └── scheduling/
│       ├── generateSlots.ts                (request, ctx) → SlotCandidate[]
│       ├── buildSchedulingMatrix.ts        bookings + candidates → DLX Matrix
│       ├── pickProvider.ts                 Q2 picker (tentative cover / count orphans / uncover)
│       ├── proposeReshuffle.ts             Q3 reshuffle (full search over pin alternatives → proposal)
│       └── scheduleAppointment.ts          Orchestration: load → pick → applyAssignment OR proposeReshuffle.
└── test/
    ├── dlx.test.ts                         10 tests
    ├── generateSlots.test.ts                7 tests
    ├── buildSchedulingMatrix.test.ts        7 tests
    ├── pickProvider.test.ts                 5 tests
    ├── proposeReshuffle.test.ts             5 tests
    ├── db.test.ts                           4 tests
    ├── repository.test.ts                    8 tests
    ├── api-health.test.ts                   1 test
    ├── seed.test.ts                          4 tests
    ├── scheduleAppointment.test.ts           4 tests
    └── printMatrix.test.ts                  4 tests
```

59 tests total, all passing. Algorithm-layer tests run in ~0.3s; DB-touching tests add ~6s total (pglite + migration setup per test) — call `npm test` to run everything, or `npx vitest run test/<file>` to target a specific suite. `npm run dev` starts the Next.js dev server; `npm run build` produces a production build (validates that the App Router and route handlers compile cleanly — currently builds `/api/health` and the auto-generated `/_not-found`).

### `src/dlx.ts` (the algorithm)

Public surface:

- **Types**: `DataNode`, `ColumnHeader` (extends DataNode), `Matrix`, `RowSpec`. Headers are themselves nodes; sentinels and empty columns are self-linked in all four directions.
- **`buildMatrix(primaryColumns, secondaryColumns, rows)`** — constructs from a row-based spec. Primary columns link into the header ring (search's `chooseColumn` walks them). Secondary columns (XCC) stay out of the ring — they get covered transitively when a row containing them is selected, but the algorithm never branches on them.
- **`cover(c)` / `uncover(c)`** — the dance. Documented in-place at length.
- **`search(matrix, options?)`** — Algorithm X with the S-heuristic. Callback API: `onSolution(rowIds) => boolean` returns `true` to stop, `false` to keep enumerating. No callback → returns the first solution only.
- **`assertMatrixInvariants(matrix)`** — test-only. Verifies horizontal/vertical pointer symmetry and that each column's `size` field matches its walked cell count.

The file is heavily commented because DLX correctness is subtle and the next person touching it will appreciate the breadcrumbs.

### `src/model.ts` (canonical data model)

Branded ID types (`ProviderId`, `ServiceId`, `LocationId`, `ProviderScheduleId`, `SlotId`, `PatientId`, `AppointmentId`) and a branded `Instant` time type (ISO 8601 UTC strings — avoids `new Date()` timezone footguns while preserving cheap equality and serialization), plus all persistent and transient entity interfaces: `Provider`, `Service`, `ProviderQualification`, `Location`, `ProviderSchedule`, `Slot`, `SlotCandidate` (= `Omit<Slot, 'id'>`), `Patient`, `Appointment`, `AppointmentRequest`. Single file by design — split per entity only when the surface area earns it. Brands are unenforceable at runtime; callers must construct IDs from valid strings.

### `src/scheduling/generateSlots.ts`

Pure function: `(request, ctx, options?) → SlotCandidate[]`. Filters schedules by qualification for the request's service, intersects each schedule with the request's window, snaps candidate starts to wall-clock granularity (default 15 minutes — so candidates land on `:00/:15/:30/:45` independent of where the window starts), enumerates fixed-duration candidates that fit. No DLX awareness; no pinned-appointment awareness. The matrix builder handles all conflict logic downstream via event intervals.

### `src/scheduling/buildSchedulingMatrix.ts`

Translates `{ bookings: SchedulingBooking[] }` into a DLX `Matrix` plus a `resolveRow(rowId)` callback that maps DLX output back to `{ bookingId, slot }`. Each booking → one primary column; each candidate → one row. Secondary columns come from the `ResourceCellSource` seam — v1 ships one source (`providerIntervalSource`) that computes per-provider event intervals from candidate slot boundaries. Adding rooms / equipment / other at-most-once axes is purely additive: append a new source to `RESOURCE_SOURCES`, no algorithmic changes. Column-id conventions are opaque to callers (`booking:{id}`, `row:{bookingId}:{idx}`, `iv:provider:{providerId}:{idx}`).

### `src/scheduling/pickProvider.ts`

Q2 picker. Context = `GenerateSlotsContext + { pinnedSlots: Slot[] }`. Builds the matrix with the request alongside pinned slots (each pin becomes a single-candidate booking — forced), covers the request's primary column, then for each candidate row tentatively covers its secondary cells, counts primary columns whose `size` drops to 0 (orphans = stranded pins), uncovers, and returns the first zero-orphan candidate's `(providerId, slot)`. Returns `null` if every candidate would strand a pin. This is the canonical "matrix as query engine" pattern — Q3 (reshuffle) and Q4 (scoring) will reuse the same cover / measure / uncover shape.

### `src/scheduling/proposeReshuffle.ts`

Q3 reshuffle. Builds the matrix with the new request as an open booking + each pinned slot as a multi-candidate open booking (per the pinned-appointment-stability constraint, alternatives are derived from `(same time + location + service, any qualified provider whose schedule covers it)`; current provider listed first so DLX prefers "no move"). Runs full `search`, returns the first feasible cover as a `ReshuffleProposal` = `{ newAssignment, movedPins }`. `movedPins` is empty when a cover exists without moving any pin (equivalent to a successful `pickProvider`). Returns `null` when no cover exists even with reshuffling. Proposal-only — does not mutate state; the caller decides whether to apply or queue for human approval. An `applyReshuffle` companion is a future addition.

### `src/db/schema.ts` (Drizzle table definitions)

Mirrors the canonical model in `src/model.ts`: tables for Provider, Service, Location, Patient, ProviderQualification (composite PK), ProviderSchedule, Slot, Appointment. ID columns are plain `text` — TypeScript brands are runtime-free, so storage is just a string; the (future) repository layer re-applies the brands at the boundary. Time columns are also `text` (ISO 8601 UTC, matching the `Instant` brand) to sidestep driver/dialect quirks around `timestamptz` serialization — SQL-level time arithmetic isn't needed at the v1 algorithm layer, and the matrix builder already does all time logic via event intervals.

Regenerate migrations after schema changes: `npm run db:generate` (writes SQL into `drizzle/`).

### `src/db/client.ts` (pglite connection + migrator + HMR-safe singleton)

Three exports:

- **`createDatabase(dataDir?)`** — returns a Drizzle client backed by embedded pglite. Pass a directory path for file-backed dev persistence, omit for a fresh in-memory database. Tests call this directly to get isolated instances.
- **`applyMigrations(db)`** — reads `drizzle/` and replays the generated SQL. Call once during app bootstrap; tests call once per `beforeEach`.
- **`getDatabase(dataDir?)`** — HMR-safe singleton for use from Next.js route handlers and server actions. Caches the migrated DB instance on `globalThis` so Next's dev-mode module re-evaluation doesn't recreate the database (and lose all state) on every save. Returns a `Promise<Database>` because migration is async.

Swap to a real Postgres later by changing two imports (`drizzle-orm/pglite` → `drizzle-orm/postgres-js`, `@electric-sql/pglite` → `postgres`) and adjusting the connection string; the schema, repository, and call sites are untouched.

### `src/db/seed.ts` (scenario seeder)

`seedScenario(db, options?)` — destructive: wipes every table in reverse-FK order and repopulates a hand-picked scenario:

- 3 providers (Alice/Bob/Carol) with overlapping qualifications. Alice + Bob are general practice (checkup + consult); Carol is specialist (consult + imaging). Only Carol does imaging — creates forced-pin scenarios for the visualizer.
- 3 services (Checkup 30min, Consult 45min, Imaging 60min) — non-trivial event-interval granularity.
- 1 location, schedules 8am–5pm UTC for all three providers.
- 4 pre-existing pinned appointments engineered for visualizer narrative: 9am Bob/checkup, 10am Carol/imaging, 11am Alice/consult, 14:00 Alice/checkup. These produce a mix of straight-pick, reshuffle-needed, and infeasible outcomes depending on what request you submit.

Date defaults to today (UTC); tests pass an explicit date for stable assertions. Slot IDs use a `pin-*` prefix so the `slotId` foreign-key references in `appointments` rows read clearly as "this appointment is pinned to that slot."

Invocation: currently only callable from code (the route handlers / server actions that will trigger it land in Phase B of item 8). Tests exercise it against in-memory pglite.

### `src/db/repository.ts` (the persistence bridge)

The only module that knows both the Drizzle schema and the canonical model brands. Three public functions:

- **`loadSchedulingContext(db)`** — one round trip (four parallel queries) that returns a `SchedulingContext` satisfying both `PickProviderContext` and `ProposeReshuffleContext`. The pinned slots come from joining `appointments` to `slots` so each pin carries its `appointmentId`. All branded types (`ProviderId`, `Instant`, …) are re-applied here at the row → canonical boundary.
- **`applyAssignment(db, slot, patientId)`** — wraps a Drizzle transaction around the atomic insert of one `Slot` plus one `Appointment`. Used after a successful `pickProvider` (and called internally by `applyReshuffle`).
- **`applyReshuffle(db, proposal, patientId)`** — materializes a `ReshuffleProposal` in a single transaction: for each `movedPin`, creates a new `Slot` (same time/location/service, new `providerId`) and retargets the existing Appointment's `slotId`; then creates the Slot + Appointment for the new assignment. Verifies the proposal is still consistent with DB state — appointment exists, current provider matches `fromProviderId` — and throws (rolling back) if the proposal is stale. Slots are append-only history; reshuffling does NOT delete the old slot rows, only retargets the Appointment.

UUIDs from `crypto.randomUUID()` provide the surrogate text IDs for new Slot and Appointment rows. The scheduling functions remain DB-agnostic — `pickProvider` and `proposeReshuffle` still take plain context shapes; only this module imports both Drizzle and the model.

### `src/scheduling/scheduleAppointment.ts` (the orchestration function)

`scheduleAppointment(db, request) → Promise<ScheduleResult>` — ties the load / pick / propose / apply machinery into one call returning a discriminated union:

```ts
type ScheduleResult =
  | { kind: 'direct'; assignment: { providerId, slot, appointment } }
  | { kind: 'proposal'; proposal: ReshuffleProposal }
  | { kind: 'infeasible' };
```

Strategy: try the cheap path first (pickProvider — first zero-orphan candidate wins, no enumeration); on null, fall back to the expensive path (proposeReshuffle — full DLX search). On a direct pick, commit the assignment via applyAssignment before returning. On a proposal, return without mutating — caller decides whether to approve via the apply action.

Lives in `src/` rather than under `app/_actions/` so it's framework-clean and testable without Next request context. The server action layer wraps this with `getDatabase` + `revalidatePath`.

### `app/_actions/scheduling.ts` (server actions)

The Next.js surface around the orchestration. `'use server'` at the file top makes every export a server action with auto-generated client stubs (typed RPC end-to-end).

- **`scheduleAppointmentAction(request)`** — wraps `scheduleAppointment`. On `kind === 'direct'`, revalidates `/visualizer` and `/` so any active visualizer picks up the new appointment on next render. Proposal/infeasible paths don't mutate, so no revalidation needed.
- **`applyReshuffleAction(proposal, patientId)`** — calls `applyReshuffle`. Throws on stale proposal (caller surfaces 409-equivalent).
- **`resetScenarioAction()`** — calls `seedScenario`. Wipes + repopulates the DB. Revalidates both pages.

The underscore in `_actions/` is a Next.js private-folder convention — excluded from routing.

### `src/printMatrix.ts`

`formatMatrix(matrix) → string` and `printMatrix(matrix) → void`. Walks the matrix's live linked structure (so partial-cover state is visible if you call it mid-search) and renders a labeled ASCII table — primary columns as `P0/P1/…`, secondary as `S0/S1/…`, cells as `X`/`.`. Used in tests and for building intuition about the encoding.

### Test summary (33 tests, all passing)

- **dlx.test.ts (10)** — Knuth's classic 7×6 example; N=4 and N=8 queens (2 and 92 solutions; validates XCC); no-solution cases; cover/uncover round-trip invariants.
- **generateSlots.test.ts (7)** — grid alignment, qualification filter, window intersection, unknown service, granularity override, multi-provider aggregation, wall-clock snapping.
- **buildSchedulingMatrix.test.ts (7)** — single bookings, no candidates, multi-provider independence, same-slot conflict, pinned + open booking interaction, swap enumeration, the event-interval worked example from this doc as an executable spec.
- **pickProvider.test.ts (5)** — no qualified provider, no pinned slots, skip-on-overlap, fully blocked → null, fall-through to alternate provider when one is fully blocked.
- **proposeReshuffle.test.ts (5)** — no qualified provider, no pinned slots, direct candidate (empty movedPins), happy single-pin move (Bob's checkup moves to Alice so Bob is free for the new consult), infeasible (no alternative provider, single qualified pin holds the only slot).
- **db.test.ts (4)** — provider round-trip, full entity-graph insert (every table, FK edges), FK integrity enforcement, composite PK enforcement on `provider_qualifications`. Each test gets a fresh pglite instance with migrations applied via `beforeEach`.
- **repository.test.ts (8)** — `loadSchedulingContext` on empty / seeded / with-pinned-appointments DBs; `applyAssignment` atomic insert + distinct IDs across calls; `applyReshuffle` with empty `movedPins`, full DB → `proposeReshuffle` → apply round trip (Bob's checkup moves to Alice so Bob can take a consult), and transactional rollback when the proposal references a ghost appointment.
- **api-health.test.ts (1)** — invokes the `/api/health` GET handler directly (no dev server) and verifies the response shape. Validates that Next.js route handlers are importable + executable from vitest.
- **seed.test.ts (4)** — `seedScenario` populates an empty DB to expected counts; reseeding wipes + repopulates idempotently; the 10am imaging case produces a `pickProvider` null AND a `proposeReshuffle` null (Carol's the only imaging provider and she's pinned); the 9am checkup case picks Alice (Bob is pinned). Last two tests double as executable narrative of the seed scenario.
- **scheduleAppointment.test.ts (4)** — orchestration. Direct-path success against seed (9am checkup → Alice; persists); infeasible path against seed (10am imaging → null, no persist); proposal path against a custom mini-fixture (Bob-only-consult-qualified, Bob pinned for checkup — request triggers reshuffle without persisting until approved).
- **printMatrix.test.ts (4)** — primary-only matrix, primary + secondary, empty rows, demo print of the HANDOFF event-interval example.

---

## Conventions in place

- **TypeScript + ESM.** Strict mode, `noUncheckedIndexedAccess`, `noImplicitOverride`. **Relative imports inside `src/` use no extension** (e.g. `from './schema'` and `from '../model'`, not `'./schema.js'`). The earlier ESM-TS `.js`-extension convention was dropped after the Next.js pivot — Turbopack's dev-mode resolver doesn't honor the `.js → .ts` mapping that Vitest, `tsc`, and the production build all do, and bare imports work in every tool we use. Tests under `test/` still use `.js` extensions when importing from `src/` (e.g. `from '../src/dlx.js'`) — Vitest handles both, no need to sweep there.
- **Vitest** for tests. Default config — no `vitest.config.ts` yet because nothing in this prototype warrants custom config.
- **Drizzle ORM** is the chosen PostgreSQL access layer for when the DB layer goes in. Not installed yet — deferred until the schema is being designed. The decision was: greenfield project, want type-safe queries, schema-as-code, lightweight migrations. Drizzle fits.
- **No README yet.** This handoff doc is the primary onboarding. A user-facing README can come later once the project has a usable surface area.
- **Algorithm-first build order.** The user explicitly chose this over "scaffold everything first" — get the core working in isolation, then add structure around it. Don't add Express / DB / data-model code until the algorithm has a stable, tested API surface.

---

## Modeling scheduling as XCC

The canonical data model is designed so scheduling decisions map cleanly to DLX matrix construction. Each entity, its lifetime, and its role:

| Entity | Lifetime | Role |
|---|---|---|
| **Provider** | persistent | Assignable resource. The only constrained resource in v1. |
| **Service** | persistent | What's being booked. `durationMinutes` lives here — slot duration follows from the service being booked, not from a fixed time grid. |
| **ProviderQualification** | persistent | `(provider, service)` join — which providers can perform which services. |
| **Location** | persistent | Where work happens. |
| **ProviderSchedule** | persistent | Per-provider availability: when they're working, where. Source of truth for raw supply. May be composed of multiple windows per provider per day. |
| **Slot** | ephemeral as candidate, persistent once booked | `(provider, location, service, start, end, status)`. The DLX matrix row, materialized as a concrete candidate object. Generated on demand from `(schedule ∩ service.duration ∩ qualification)`. Persisted with `status='busy'` once DLX picks it — that's the booking. Canceled bookings remain in the table with `status='canceled'` (append-only history). |
| **BookingRequest** | DTO only — never persisted | Function input: `(serviceId, window)`. Anonymous — no patient identity. |

IDs are branded string types (`ProviderId`, `SlotId`, …) so the type system catches cross-entity mix-ups. Times are a branded `Instant` (string under the hood) for explicit semantics and to avoid `new Date()` timezone footguns.

### Lifecycle model (Option C — no persisted request entity)

Requests don't persist. The scheduling entry point is a function call:

```ts
schedule(requests: AppointmentRequest[]) => Appointment[]
```

Inside that call: generate candidate Slots from each request × each qualified provider × that provider's schedule, run DLX, persist the chosen Slots, wrap each in an Appointment. Existing Appointments contribute pinned rows so they survive any re-solve.

Status lifecycle is intentionally minimal — Appointments in the database are confirmed. Cancellation = delete. No tentative/proposed states until they earn their keep.

### The matrix

- **Primary columns**: one per `AppointmentRequest`. Exactly-once — every request gets exactly one Slot.
- **Secondary columns**: `(provider, event-interval)` pairs. At-most-once — a provider can hold at most one Slot in any time atom.
- **Rows**: candidate Slots. Each row's cells are its request's primary column plus every `(provider, event-interval)` secondary column its `[start, end)` window intersects.

### Event intervals (how time-overlap is encoded)

Slots have variable duration (each service has its own). Different Slots for the same provider can overlap in arbitrary ways. The trick: rather than enumerate pairwise conflicts, slice each provider's day into maximal intervals during which the active-slot set doesn't change.

**Per provider**: collect every distinct start/end timestamp across all candidate Slots and pinned Appointments. Sort. Consecutive timestamps define event intervals. Create one secondary column `(provider, interval)` for each. Each Slot row touches every interval its `[start, end)` covers.

Concrete example. Provider Alice has four candidate Slots:

| Slot | Service | Duration | Time |
|---|---|---|---|
| SA | Checkup | 15 min | 9:00–9:15 |
| SB | Consult | 30 min | 9:00–9:30 |
| SC | Checkup | 15 min | 9:15–9:30 |
| SD | Procedure | 45 min | 9:15–10:00 |

Distinct event times: 9:00, 9:15, 9:30, 10:00. Event intervals: I1=[9:00,9:15), I2=[9:15,9:30), I3=[9:30,10:00).

```
Time:    9:00      9:15      9:30      9:45     10:00
         |---------|---------|---------|---------|

SA       [=========]
SB       [===================]
SC                 [=========]
SD                 [===================================]

         (-- I1 --)(-- I2 --)(--------- I3 ----------)
```

| Row | (Alice, I1) | (Alice, I2) | (Alice, I3) |
|---|---|---|---|
| SA | X |   |   |
| SB | X | X |   |
| SC |   | X |   |
| SD |   | X | X |

The at-most-once dance enforces non-overlap. {SA, SB} double-hits I1 → blocked. {SC, SD} double-hits I2 → blocked. {SA, SC} clears all columns at most once → allowed (and is exactly the non-overlapping back-to-back booking).

Two Slots overlap iff their interval sets intersect. The matrix structure encodes that — no special-case code per pair.

### Pinned appointments

Existing Appointments contribute their (already-persisted) Slot as a row in the matrix and their start/end as event-time boundaries. No alternative rows for that booking are added; the algorithm has no choice but to include it. Any candidate that conflicts is automatically ruled out by the at-most-once columns.

### Additive extension to more resources

Provider is the only constrained resource in v1, but the formulation is designed so adding rooms, equipment, or other at-most-once resources is purely additive:

1. Compute event intervals per resource (per room, per equipment unit, …) the same way they're computed per provider.
2. Add `(resource, interval)` secondary columns.
3. Each Slot row gains cells for the resources it requires.

The algorithm doesn't change. The matrix builder grows by adding a new "resource-cell source" — a function that emits `(secondaryColumnKey, rowIds)` triples for that resource type. Keep this seam clean in `buildSchedulingMatrix.ts` from day one even though only the provider source ships in v1 — that's what makes the extension truly additive later.

### The four scheduling questions

Each maps to a query against the same matrix:

1. **Feasibility** (Q1): `search(matrix)` returns a non-empty cover.
2. **Picker** (Q2) — when multiple providers qualify: tentatively `cover` each candidate Slot row, count primary columns whose `size` drops to 0 (newly unfillable requests), `uncover`, pick the row with the lowest consequence count.
3. **Reshuffle** (Q3): include the new candidate as a row, run `search`, diff the resulting row set against current Appointments; differences are the reshuffle.
4. **Multi-objective scoring** (Q4): enumerate covers via `onSolution => false`, score each, pick the best.

---

## Recommended next steps (in priority order)

Items 1–7 are done. Live work starts at item 8.

✓ 1. **Define TS types in `src/model.ts`.** All entities, branded IDs, branded `Instant`. Single file. **Done.**
✓ 2. **`src/scheduling/generateSlots.ts`.** Pure candidate generation. **Done** with 7 tests.
✓ 3. **`src/scheduling/buildSchedulingMatrix.ts`.** Booking + candidate adapter to DLX `Matrix`, with the `ResourceCellSource` seam in place for additive resource axes. **Done** with 7 tests.
✓ 4. **Picker (Q2)** — `src/scheduling/pickProvider.ts`. Tentative-cover / count-orphans / uncover; first zero-orphan candidate wins. **Done** with 5 tests.
✓ 5. **Reshuffle (Q3)** — `src/scheduling/proposeReshuffle.ts`. Builds the matrix with the new request + each pin as a multi-candidate open booking (alternatives = other qualified providers available at same time/location), runs full `search`, returns `{ newAssignment, movedPins } | null`. Proposal-only — does not mutate state. Per the pinned-appointment-stability constraint, only `providerId` is reshuffle-eligible (time/location/service/patient stay fixed). **Done** with 5 tests.
✓ 6. **PostgreSQL schema + Drizzle setup** — `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`, `drizzle/` migrations. v1 uses embedded pglite (no Docker); swap to real Postgres later by changing two imports. **Done** with 4 smoke tests.
✓ 7. **Persistence bridge** ("repository layer") — `src/db/repository.ts`. `loadSchedulingContext` (one round trip, both contexts), `applyAssignment` (atomic Slot + Appointment), `applyReshuffle` (transactional multi-row mutation with stale-proposal detection). Branded-type re-application lives here at the only Drizzle↔canonical boundary. **Done** with 8 tests including a full end-to-end round trip (load → propose → apply → reload).

— Live work starts here —

8. **Next.js HTTP surface.** *Setup done — Phase 1 in place: `app/` directory, root `layout.tsx`, `/api/health` smoke route, HMR-safe DB singleton (`getDatabase`), `next.config.mjs` marking pglite as a `serverExternalPackage`, `npm run build` clean. Tailwind v4 wired up. `components/` folder with `@/*` path alias. Navbar in root layout. Phase A of visualizer roadmap done: `src/db/seed.ts` ready, 4 tests. Phase B done: orchestration function + three server actions (`scheduleAppointmentAction`, `applyReshuffleAction`, `resetScenarioAction`), 4 orchestration tests.* Phase C (the visualizer page) is what's left:
   - **Phase C — visualizer page** (`app/visualizer/page.tsx`, currently a placeholder). Server component: reads current state via `loadSchedulingContext(await getDatabase())`. Renders the scenario (timeline + matrix per the [[visualizer-modes-direction]] memory — multi-mode UI). Form to submit `AppointmentRequest`; calls `scheduleAppointmentAction`. Result panel: direct → success toast; proposal → approve/reject UI calling `applyReshuffleAction`; infeasible → friendly message. Header includes a "reset scenario" button calling `resetScenarioAction`. Multi-mode framing: timeline for laypeople, matrix view for algorithm narrative, possibly a hybrid. Decisions on exact modes pending — surface options when Phase C starts.
   - **(Possible later)** REST endpoints alongside the actions if external/curl callers ever need them: `POST /api/schedule`, `POST /api/reshuffle/apply`, `GET /api/appointments`, `DELETE /api/appointments/:id`. Not needed for the visualizer.
   - Per the pglite-as-singleton constraint, run with a single worker in dev. Vercel deployment would require swapping to real Postgres ([[product-compass]] hand-off).
9. **End-to-end test fixture.** 3–5 providers, mixed qualifications, a day's worth of requests, demonstrating feasibility / picker / reshuffle answered correctly end to end via the Next route handlers, with mutations persisted. Different from the in-process round trip already covered by `repository.test.ts` — this one drives the HTTP layer too. Invoke route handlers directly from vitest (the `api-health.test.ts` pattern) or via `fetch` against a `next dev` server — pick when we get here.

**Possible future:** Q4 multi-objective scoring (enumerate covers, score each, pick best). Gated by whether real product needs surface a tiebreaking objective. Per the product compass, scoring is welcome as a tiebreaker but should never become the point of the system.

Avoid: building a UI, building auth, or building production-grade migration/deployment tooling. This is a prototype to validate the algorithm-first thesis; production-readiness comes later if the prototype proves the thesis.

---

## Glossary (terms used above that might be unfamiliar)

- **Algorithm X** — Knuth's recursive backtracking algorithm for the exact-cover problem.
- **Dancing Links (DLX)** — the data structure that makes Algorithm X efficient by representing the matrix as a sparse doubly-linked structure where cover/uncover are O(1) splice/unsplice operations.
- **Exact cover** — given a 0/1 matrix, find a subset of rows such that every column has exactly one 1.
- **XCC** — Algorithm X with Colors / Constraints. The extension to "secondary" columns that must be covered *at most once* (rather than exactly once). Without XCC, DLX can't directly model scheduling constraints like "no provider double-booked."
- **S-heuristic** — at each branching step, choose the primary column with the fewest cells. Standard "most-constrained-variable-first" heuristic; makes Algorithm X explore the search tree efficiently.
- **Event interval** — in scheduling, the maximal time interval during which the set of active bookings doesn't change (no booking starts or ends within it). Used as the granularity for secondary columns: one secondary column per `(provider, interval)`.
- **Pinned booking** — a booking whose provider assignment is fixed (e.g., a patient picked a specific provider). Modeled by including only the pinned `(booking, provider)` row in the matrix; the algorithm has no alternative to consider.

---

## What's intentionally NOT here

- **No bipartite-matching primitive.** A different scheduling-algorithm option that's idiomatic in some healthcare scheduling systems. DLX is strictly more flexible (handles all four scheduling questions, not just feasibility); we don't need both. If a future reader is wondering why this project isn't using a `canScheduleAllBookings`-style bipartite primitive, the answer is "because DLX subsumes it."
- **No FHIR resources.** Deliberate. This is a canonical-data-model project.
- **No production-grade error handling, logging, auth, or deployment.** Prototype, not product.
- **No frontend.** Backend-and-algorithm only.

---

If anything in this handoff is unclear, ask the user — they have the full design context. Don't guess at things the document doesn't cover; the user can fill in.
