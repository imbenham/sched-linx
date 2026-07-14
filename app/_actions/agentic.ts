// Server actions for the agentic-onboarding route. Slice 2 scope:
// tool-loop conversation (the assistant records the setup into a
// structured `seed_plan` as it goes) + commit action (promote the plan
// into tag-scoped scheduling rows the rest of the app already knows how
// to query).
//
// Architectural notes:
//
// - The seed plan is the staging area. Nothing lands in the live
//   scheduling tables until the user commits. That way in-conversation
//   tool failures (unsupported primitives) surface immediately without
//   polluting the scheduling schema, and the user gets a chance to
//   review before promoting.
//
// - Dialog storage uses Anthropic-shaped content blocks (text, tool_use,
//   tool_result) so a stored dialog can be replayed through the SDK
//   without translation. Existing rows created under slice 1 stored
//   `content: string`; getSetup normalizes those on read.
//
// - IDs for plan entities are server-generated and returned via
//   tool_result. This eliminates hallucinated-ID collisions the model
//   could otherwise introduce when chaining tool calls in one turn.
//
// - Times in the plan are ISO 8601 UTC Instants. The model composes
//   concrete dates itself; if that turns out to be error-prone we'll
//   add higher-level tools (set_weekly_capacity(dayOfWeek, ...)) then.

'use server';

import { randomUUID } from 'node:crypto';
import { and, eq, desc } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import Anthropic from '@anthropic-ai/sdk';
import { getDatabase } from '@/src/db/client';
import { githubUrl, isAgenticReadOnly } from '@/src/env';
import {
  agenticSetups,
  locations,
  locationSchedules,
  providers,
  providerQualifications,
  providerSchedules,
  rooms,
  services,
  servicesRoomRequirements,
  slots,
} from '@/src/db/schema';

const ROUTE_PATH = '/agentic-onboarding';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Cap on how many model → tools → model round-trips a single user turn
// can trigger. Runaway-loop backstop, not a productivity constraint —
// real scenarios legitimately need 10+ iterations when the practice has
// many locations × many time windows.
const MAX_TOOL_LOOP_ITERATIONS = 24;

// Per-response token budget. Tool calls consume tokens quickly (each
// tool_use block ≈ 40–80 tokens), so a batch of 15+ schedule inserts
// plus narration can hit a lower cap and truncate mid-turn.
const MAX_TOKENS_PER_TURN = 4096;

// System prompt is built per-call so the model always sees today's
// date. Otherwise it tends to materialize concrete schedule windows
// against dates from its training-data era, which lands the seed plan
// in the past.
function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return SYSTEM_PROMPT_TEMPLATE.replace('{{TODAY}}', today);
}

const SYSTEM_PROMPT_TEMPLATE = `You are an onboarding assistant for sched-linx, a scheduling system for
healthcare practices. Your job is to help a user describe their practice setup —
providers, services they offer, rooms or equipment that constrain scheduling, and
typical schedule patterns — through conversation, and to record what you learn
into a structured seed plan using the tools available to you.

Today's date is {{TODAY}} (UTC). All concrete schedule windows you record
should be dated in the near future — a Monday one or two weeks after today,
laid across a representative week. Do not pick dates in the past.

## Conversation style
- Be conversational, not interrogative. Ask one or two focused questions at a
  time rather than a long checklist.
- Summarize back what you've heard so the user can correct as you go.
- Probe gently when something the user says implies a scheduling complication
  (multi-room equipment, providers with subspecialties, recurring slots,
  urgent-care-style capacity vs. provider-scheduled specialty visits, multi-
  location routing).
- Use plain language; this isn't a technical interview.

## Recording the setup
As the conversation makes each detail concrete, record it via tools:
- \`add_location\`, \`add_location_schedule\` — clinic sites and their capacity
  windows (shifts). Location schedules with a capacity are what
  location-scheduled services book against.
- \`add_service\` — each distinct visit type, with duration, whether it
  requires a specific provider (specialty consult) or is location-scheduled
  (walk-in urgent care), whether it needs a room, and any booking cadence.
- \`add_provider\`, \`add_qualification\`, \`add_provider_schedule\` — for
  provider-scheduled services.
- \`add_room\`, \`add_service_room_requirement\` — when specific rooms are
  the constraint (imaging, procedure rooms).
- \`add_pinned_slot\` — optional pre-seeded existing bookings, if the user
  wants their scenario to open with realistic state.
- \`remove_*\` — when the user corrects something.

### Recording order matters
Location schedules exist *to provide capacity for services*. Before
recording any location schedules, make sure at least one service is
recorded — otherwise the schedules have nothing to give capacity for and
the plan can't be committed. A good default order is:
locations → services → (providers + qualifications if provider-scheduled)
→ schedules → pinned slots. It is fine to loop back later, but never
leave the plan in a state with schedules but no services.

### Be efficient with tool calls
When a burst of similar tool calls is needed (many location schedules
covering a week, many provider qualifications), emit them all in one
turn as parallel tool calls rather than narrating and calling one at a
time. A brief summary bracketing the burst is fine; per-day play-by-play
is not.

### Minimum committable state
The plan needs at least one \`location\` **and** at least one \`service\`
before the user can commit. If you have recorded schedules or providers
but no service, keep working — the plan isn't finishable yet.

## When sched-linx can't express something
Not every practice detail maps cleanly onto our primitives. Before flagging,
ask yourself two questions:

1. **Can the user express this by choosing specific values for the primitives
   we already have?** How the practice *decides* on those values (analyzing
   historical demand, reacting to a staffing change, gut feel) is off-system
   reasoning. The resulting numbers landing in the schedule *is* the
   representation. That's supported.

2. **Does the described behavior require sched-linx itself to sense or react
   to something outside its own inputs** (live walk-in counts, real-time
   staffing changes it isn't told about, external signals)? If yes, that
   automation is what's unsupported — even if the *outcome* the practice
   wants could be achieved by a human editing the schedule instead.

Concrete calibration:
- "We set pre-book capacity with expected walk-in volume in mind" → supported.
  The practice's per-window capacity numbers *are* the expression. No flag.
- "We adjust the weekly schedule mid-week when staffing changes" → supported.
  Human edits schedule rows. No flag.
- "Whichever location's provider accepts the telehealth visit first handles
  it" → supported. This is a resolution timing choice, not a missing
  primitive — the booking assignment resolves against location capacity at
  accept time. Same substrate, different call site. No flag.
- "The system should auto-cancel appointments when we're understaffed" →
  flag as blocking. Requires system-owned reactive behavior we don't have.
- "The system reroutes bookings when walk-in volume spikes" → flag as
  blocking. Same reason.

When you do flag, be honest with the user about what specifically is
unsupported vs. what part is fine, and make sure the flag description is
precise enough to be useful to a reviewer.

## Wrapping up
When you have enough to seed a coherent scenario, call \`finalize_plan\` with
a short title and a summary of the practice. That signals the UI to enable
the commit button. Only finalize when the user has confirmed the summary.

## Concrete dates
Time inputs to tools are ISO 8601 UTC Instants (e.g. "2026-08-03T14:00:00Z").
The user typically speaks in relative or recurring terms ("Monday morning",
"weekdays 8am to noon"). Materialize a concrete near-future week — pick a
Monday one or two weeks after today's date (given above) and lay the described
windows across it.

## Timezones
Every location has its own timezone (locations in different regions may differ).
When the user names a timezone, record it as an IANA identifier on the location:
"Pacific" → "America/Los_Angeles", "Eastern" → "America/New_York", "UK" →
"Europe/London", etc. Pass \`timezone\` when calling \`add_location\`, or use
\`set_location_timezone\` if it comes up after. When a user says "8am to
midnight" in the context of a specific location, convert to UTC using that
location's timezone. If a location's timezone hasn't been established yet,
ask before recording concrete schedule windows there — a scheduled window in
the wrong timezone renders incorrectly in the calendar.`;

const STARTER_ASSISTANT_MESSAGE = `Hi! I'll help you describe your practice so we can spin up a sched-linx scenario that matches how you actually run.

Let's start with a couple of orientation questions:

1. What kind of practice is it? (e.g. specialty consult clinic, urgent care, primary care, physical therapy, group therapy)
2. Roughly how big? (Number of providers, or number of patients you typically see in a day.)

Once I have that, we'll get into the specifics — the services you offer, whether you have rooms or equipment that constrain scheduling, and the pattern of how appointments are booked (scheduled per-provider, walk-in against capacity, or a mix).`;

const client = new Anthropic();

// ─── Seed plan (staging area) ────────────────────────────────────────────────

export interface PlanLocation {
  id: string;
  name: string;
  // IANA timezone identifier. Optional at intake; the model should
  // record it as soon as the user names a timezone.
  timezone?: string;
}
export interface PlanLocationSchedule {
  id: string;
  locationId: string;
  start: string;
  end: string;
  capacity?: number;
}
export interface PlanService {
  id: string;
  name: string;
  durationMinutes: number;
  requiresProvider: boolean;
  requiresRoom?: boolean;
  bookingCadenceMinutes?: number;
}
export interface PlanProvider {
  id: string;
  name: string;
}
export interface PlanQualification {
  providerId: string;
  serviceId: string;
}
export interface PlanProviderSchedule {
  id: string;
  providerId: string;
  locationId: string;
  start: string;
  end: string;
}
export interface PlanRoom {
  id: string;
  name: string;
  locationId: string;
  type: string;
}
export interface PlanServiceRoomRequirement {
  serviceId: string;
  roomType: string;
}
export interface PlanPinnedSlot {
  id: string;
  serviceId: string;
  locationId: string;
  start: string;
  end: string;
  providerId?: string;
  roomId?: string;
}
export interface PlanUnsupported {
  description: string;
  // workaround = we're representing it approximately with an
  // available primitive; blocking = we're not modeling it at all.
  severity: 'workaround' | 'blocking';
}

export interface SeedPlan {
  locations: PlanLocation[];
  locationSchedules: PlanLocationSchedule[];
  services: PlanService[];
  providers: PlanProvider[];
  qualifications: PlanQualification[];
  providerSchedules: PlanProviderSchedule[];
  rooms: PlanRoom[];
  serviceRoomRequirements: PlanServiceRoomRequirement[];
  pinnedSlots: PlanPinnedSlot[];
  unsupported: PlanUnsupported[];
}

function emptyPlan(): SeedPlan {
  return {
    locations: [],
    locationSchedules: [],
    services: [],
    providers: [],
    qualifications: [],
    providerSchedules: [],
    rooms: [],
    serviceRoomRequirements: [],
    pinnedSlots: [],
    unsupported: [],
  };
}

// ─── Dialog storage (Anthropic-shaped content blocks) ────────────────────────

export type StoredContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export interface DialogMessage {
  role: 'user' | 'assistant';
  content: StoredContentBlock[];
  timestamp: string;
}

export interface AgenticSetupSummary {
  id: string;
  tag: string;
  title: string | null;
  status: string;
  createdAt: string;
  committedAt: string | null;
}

export interface AgenticSetupDetail extends AgenticSetupSummary {
  useCaseSummary: string | null;
  dialog: DialogMessage[];
  seedPlan: SeedPlan;
  // One plan snapshot per raw dialog index. `planSnapshots[i]` is the
  // plan state after processing dialog[0..i-1]; length = dialog.length + 1.
  // Used by the chat's replay mode so the sidebar tracks the message-by-
  // message reveal rather than showing the final state throughout.
  planSnapshots: SeedPlan[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateTag(id: string): string {
  return `agentic-${id.slice(0, 8)}`;
}

// Normalize dialog rows written under slice 1 (content was a string) so
// this action file can assume the block shape everywhere.
function normalizeDialog(raw: unknown): DialogMessage[] {
  if (!Array.isArray(raw)) return [];
  const normalized: DialogMessage[] = raw.map((m: any) => ({
    role: m.role,
    timestamp: m.timestamp,
    content:
      typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : (m.content as StoredContentBlock[]),
  }));
  return healDialog(normalized);
}

// Repair a dialog whose tool_use blocks aren't paired 1-for-1 with
// tool_result blocks in the immediately-following message. An older
// version of the tool loop could persist tool_use blocks without
// executing them on max_tokens truncation; the Anthropic API then
// refuses any further call on that dialog. Here we synthesize the
// missing tool_result blocks so those sessions become usable again.
// Only applied at read time; a healed dialog isn't persisted back to
// the DB unless a subsequent write flushes it. New sessions land
// well-formed via the fixed tool loop.
function healDialog(dialog: DialogMessage[]): DialogMessage[] {
  const healed: DialogMessage[] = [];
  for (let i = 0; i < dialog.length; i++) {
    const msg = dialog[i]!;
    healed.push(msg);
    if (msg.role !== 'assistant') continue;
    const toolUseIds = msg.content
      .filter(
        (b): b is Extract<StoredContentBlock, { type: 'tool_use' }> =>
          b.type === 'tool_use',
      )
      .map((b) => b.id);
    if (toolUseIds.length === 0) continue;
    const next = dialog[i + 1];
    const nextResultIds = new Set<string>();
    if (next?.role === 'user') {
      for (const b of next.content) {
        if (b.type === 'tool_result') nextResultIds.add(b.tool_use_id);
      }
    }
    const missing = toolUseIds.filter((id) => !nextResultIds.has(id));
    if (missing.length === 0) continue;
    const synthetic: StoredContentBlock[] = missing.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: JSON.stringify({
        ok: false,
        note: 'tool_result synthesized after max_tokens truncation',
      }),
      is_error: true,
    }));
    if (next?.role === 'user') {
      // Merge the synthesized results into the existing tool_result turn.
      healed.push({
        ...next,
        content: [...next.content, ...synthetic],
      });
      i++;
    } else {
      // Insert a brand-new synthetic tool_result turn between the
      // orphan assistant and whatever came next.
      healed.push({
        role: 'user',
        content: synthetic,
        timestamp: msg.timestamp,
      });
    }
  }
  return healed;
}

// ─── Tool schemas ────────────────────────────────────────────────────────────
//
// Names are snake_case to match Claude's training distribution. Inputs are
// snake_case for the same reason; the executor bridges to the seed plan's
// camelCase storage.

const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'add_location',
    description:
      'Record a physical clinic site. Returns the generated id you should use to reference this location in later tool calls (schedules, rooms, provider schedules, pinned slots).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (e.g. "Downtown Clinic").' },
        timezone: {
          type: 'string',
          description:
            'IANA timezone identifier (e.g. "America/Los_Angeles", "America/New_York"). Record this whenever the user names a timezone. If unknown, omit and ask the user before recording concrete schedule windows.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_location_timezone',
    description:
      'Update the IANA timezone for a location already recorded. Use this if the timezone became clear only after the location was added.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        timezone: {
          type: 'string',
          description: 'IANA timezone identifier (e.g. "America/Los_Angeles").',
        },
      },
      required: ['id', 'timezone'],
    },
  },
  {
    name: 'remove_location',
    description:
      'Remove a location by id. Also removes any location_schedules, rooms, and provider_schedules that referenced it.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'add_location_schedule',
    description:
      'Record a capacity window at a location — a shift with a specific number of concurrent booking seats. Used by location-scheduled services (services with requires_provider=false).',
    input_schema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 UTC start.' },
        end: { type: 'string', description: 'ISO 8601 UTC end.' },
        capacity: {
          type: 'integer',
          description:
            'Number of concurrent appointments this shift can support. Omit if the window is only used to bound provider hours and no location-based booking happens here.',
        },
      },
      required: ['location_id', 'start', 'end'],
    },
  },
  {
    name: 'remove_location_schedule',
    description: 'Remove a location_schedule by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'add_service',
    description:
      'Record a distinct visit type the practice offers. Returns the generated id.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        duration_minutes: { type: 'integer' },
        requires_provider: {
          type: 'boolean',
          description:
            'True for specialty visits scheduled against a specific provider. False for walk-in / capacity-based services (urgent care) that book against a location schedule.',
        },
        requires_room: {
          type: 'boolean',
          description:
            'True if the service needs a room that meets its room requirements. Optional; defaults to false.',
        },
        booking_cadence_minutes: {
          type: 'integer',
          description:
            'How often a new appointment can start, in minutes. Distinct from duration: duration=15, cadence=10 means 6 starts per hour with peak concurrency 2. Omit to default cadence to duration.',
        },
      },
      required: ['name', 'duration_minutes', 'requires_provider'],
    },
  },
  {
    name: 'remove_service',
    description:
      'Remove a service by id. Also removes qualifications and room requirements referencing it.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'add_service_room_requirement',
    description:
      'Restrict a service to rooms of the given type. If a service has no room requirements recorded, any room type works (subject to requires_room).',
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string' },
        room_type: { type: 'string' },
      },
      required: ['service_id', 'room_type'],
    },
  },
  {
    name: 'remove_service_room_requirement',
    description: 'Remove a service→room-type requirement.',
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string' },
        room_type: { type: 'string' },
      },
      required: ['service_id', 'room_type'],
    },
  },
  {
    name: 'add_provider',
    description: 'Record a provider. Returns the generated id.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'remove_provider',
    description:
      'Remove a provider by id. Also removes qualifications and provider_schedules referencing them.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'add_qualification',
    description: 'Record that a provider can perform a service.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string' },
        service_id: { type: 'string' },
      },
      required: ['provider_id', 'service_id'],
    },
  },
  {
    name: 'remove_qualification',
    description: 'Remove a provider→service qualification.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string' },
        service_id: { type: 'string' },
      },
      required: ['provider_id', 'service_id'],
    },
  },
  {
    name: 'add_provider_schedule',
    description:
      'Record a window during which a provider is available at a location. Provider-scheduled services book against these.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string' },
        location_id: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 UTC start.' },
        end: { type: 'string', description: 'ISO 8601 UTC end.' },
      },
      required: ['provider_id', 'location_id', 'start', 'end'],
    },
  },
  {
    name: 'remove_provider_schedule',
    description: 'Remove a provider_schedule by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'add_room',
    description:
      'Record a physical room at a location, with a type (e.g. "exam", "mri", "procedure"). Returns the generated id.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        location_id: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['name', 'location_id', 'type'],
    },
  },
  {
    name: 'remove_room',
    description: 'Remove a room by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'add_pinned_slot',
    description:
      'Pre-seed an existing busy booking so the scenario opens with realistic state. Use sparingly — only when the user asks for a specific pattern (e.g. "show me what 9am looks like when half the exam rooms are already booked").',
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string' },
        location_id: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        provider_id: {
          type: 'string',
          description:
            'Required for provider-scheduled services; omit for location-scheduled ones.',
        },
        room_id: { type: 'string' },
      },
      required: ['service_id', 'location_id', 'start', 'end'],
    },
  },
  {
    name: 'remove_pinned_slot',
    description: 'Remove a pinned_slot by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'flag_unsupported',
    description:
      'Record a practice detail that sched-linx cannot express with its available primitives. Use "workaround" when you approximated with something close; use "blocking" when you had to skip it entirely.',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description:
            'What the user described and why the primitives don\'t cover it. Written for a human reviewer.',
        },
        severity: {
          type: 'string',
          enum: ['workaround', 'blocking'],
        },
      },
      required: ['description', 'severity'],
    },
  },
  {
    name: 'finalize_plan',
    description:
      'Signal that the seed plan is complete and ready for the user to commit. Only call this after the user has confirmed your summary. Sets the setup\'s title and use-case summary.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short scenario title (< 60 chars).' },
        summary: {
          type: 'string',
          description: 'Human-readable summary of the practice for later review.',
        },
      },
      required: ['title', 'summary'],
    },
  },
];

// ─── Tool executor ───────────────────────────────────────────────────────────
//
// Pure over (plan, name, input) → (plan', resultText, isError, finalize?).
// No DB writes here; the caller persists the updated plan once at the end
// of the tool loop. `finalize` is a side-channel so the outer action can
// stash title/summary on the setup row alongside the plan.

interface ExecuteToolOutcome {
  plan: SeedPlan;
  result: string;
  isError?: boolean;
  finalize?: { title: string; summary: string };
}

function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Missing required string \`${key}\``);
  }
  return v;
}

function requireInt(input: Record<string, unknown>, key: string): number {
  const v = input[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`Missing required integer \`${key}\``);
  }
  return v;
}

function optionalInt(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`Field \`${key}\` must be an integer if provided`);
  }
  return v;
}

function optionalBool(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') {
    throw new Error(`Field \`${key}\` must be a boolean if provided`);
  }
  return v;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') {
    throw new Error(`Field \`${key}\` must be a string if provided`);
  }
  return v;
}

function requireExists<T extends { id: string }>(
  collection: T[],
  id: string,
  kind: string,
): void {
  if (!collection.some((x) => x.id === id)) {
    throw new Error(`No ${kind} exists with id \`${id}\``);
  }
}

// `newId`: caller-provided id for the entity this tool creates
// (add_location, add_service, etc.). Left undefined during a live
// tool loop → the executor mints a fresh UUID. Set by the replay path
// so reconstructed snapshots carry the same ids the original run used —
// otherwise a subsequent remove_* call would reference an id the
// reconstructed plan never emitted.
function executeTool(
  plan: SeedPlan,
  name: string,
  input: Record<string, unknown>,
  newId?: string,
): ExecuteToolOutcome {
  try {
    switch (name) {
      case 'add_location': {
        const loc: PlanLocation = {
          id: newId ?? randomUUID(),
          name: requireString(input, 'name'),
          timezone: optionalString(input, 'timezone'),
        };
        return {
          plan: { ...plan, locations: [...plan.locations, loc] },
          result: JSON.stringify({ id: loc.id }),
        };
      }
      case 'set_location_timezone': {
        const id = requireString(input, 'id');
        const timezone = requireString(input, 'timezone');
        requireExists(plan.locations, id, 'location');
        return {
          plan: {
            ...plan,
            locations: plan.locations.map((l) =>
              l.id === id ? { ...l, timezone } : l,
            ),
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'remove_location': {
        const id = requireString(input, 'id');
        requireExists(plan.locations, id, 'location');
        return {
          plan: {
            ...plan,
            locations: plan.locations.filter((l) => l.id !== id),
            locationSchedules: plan.locationSchedules.filter((s) => s.locationId !== id),
            rooms: plan.rooms.filter((r) => r.locationId !== id),
            providerSchedules: plan.providerSchedules.filter((s) => s.locationId !== id),
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'add_location_schedule': {
        const locationId = requireString(input, 'location_id');
        requireExists(plan.locations, locationId, 'location');
        const sched: PlanLocationSchedule = {
          id: newId ?? randomUUID(),
          locationId,
          start: requireString(input, 'start'),
          end: requireString(input, 'end'),
          capacity: optionalInt(input, 'capacity'),
        };
        return {
          plan: { ...plan, locationSchedules: [...plan.locationSchedules, sched] },
          result: JSON.stringify({ id: sched.id }),
        };
      }
      case 'remove_location_schedule': {
        const id = requireString(input, 'id');
        return {
          plan: {
            ...plan,
            locationSchedules: plan.locationSchedules.filter((s) => s.id !== id),
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'add_service': {
        const svc: PlanService = {
          id: newId ?? randomUUID(),
          name: requireString(input, 'name'),
          durationMinutes: requireInt(input, 'duration_minutes'),
          requiresProvider: input['requires_provider'] === true,
          requiresRoom: optionalBool(input, 'requires_room'),
          bookingCadenceMinutes: optionalInt(input, 'booking_cadence_minutes'),
        };
        return {
          plan: { ...plan, services: [...plan.services, svc] },
          result: JSON.stringify({ id: svc.id }),
        };
      }
      case 'remove_service': {
        const id = requireString(input, 'id');
        return {
          plan: {
            ...plan,
            services: plan.services.filter((s) => s.id !== id),
            qualifications: plan.qualifications.filter((q) => q.serviceId !== id),
            serviceRoomRequirements: plan.serviceRoomRequirements.filter(
              (r) => r.serviceId !== id,
            ),
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'add_service_room_requirement': {
        const serviceId = requireString(input, 'service_id');
        const roomType = requireString(input, 'room_type');
        requireExists(plan.services, serviceId, 'service');
        const already = plan.serviceRoomRequirements.some(
          (r) => r.serviceId === serviceId && r.roomType === roomType,
        );
        if (already) return { plan, result: JSON.stringify({ ok: true, alreadyPresent: true }) };
        return {
          plan: {
            ...plan,
            serviceRoomRequirements: [
              ...plan.serviceRoomRequirements,
              { serviceId, roomType },
            ],
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'remove_service_room_requirement': {
        const serviceId = requireString(input, 'service_id');
        const roomType = requireString(input, 'room_type');
        return {
          plan: {
            ...plan,
            serviceRoomRequirements: plan.serviceRoomRequirements.filter(
              (r) => !(r.serviceId === serviceId && r.roomType === roomType),
            ),
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'add_provider': {
        const p: PlanProvider = { id: newId ?? randomUUID(), name: requireString(input, 'name') };
        return {
          plan: { ...plan, providers: [...plan.providers, p] },
          result: JSON.stringify({ id: p.id }),
        };
      }
      case 'remove_provider': {
        const id = requireString(input, 'id');
        return {
          plan: {
            ...plan,
            providers: plan.providers.filter((p) => p.id !== id),
            qualifications: plan.qualifications.filter((q) => q.providerId !== id),
            providerSchedules: plan.providerSchedules.filter(
              (s) => s.providerId !== id,
            ),
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'add_qualification': {
        const providerId = requireString(input, 'provider_id');
        const serviceId = requireString(input, 'service_id');
        requireExists(plan.providers, providerId, 'provider');
        requireExists(plan.services, serviceId, 'service');
        const already = plan.qualifications.some(
          (q) => q.providerId === providerId && q.serviceId === serviceId,
        );
        if (already) return { plan, result: JSON.stringify({ ok: true, alreadyPresent: true }) };
        return {
          plan: {
            ...plan,
            qualifications: [...plan.qualifications, { providerId, serviceId }],
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'remove_qualification': {
        const providerId = requireString(input, 'provider_id');
        const serviceId = requireString(input, 'service_id');
        return {
          plan: {
            ...plan,
            qualifications: plan.qualifications.filter(
              (q) => !(q.providerId === providerId && q.serviceId === serviceId),
            ),
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'add_provider_schedule': {
        const providerId = requireString(input, 'provider_id');
        const locationId = requireString(input, 'location_id');
        requireExists(plan.providers, providerId, 'provider');
        requireExists(plan.locations, locationId, 'location');
        const sched: PlanProviderSchedule = {
          id: newId ?? randomUUID(),
          providerId,
          locationId,
          start: requireString(input, 'start'),
          end: requireString(input, 'end'),
        };
        return {
          plan: { ...plan, providerSchedules: [...plan.providerSchedules, sched] },
          result: JSON.stringify({ id: sched.id }),
        };
      }
      case 'remove_provider_schedule': {
        const id = requireString(input, 'id');
        return {
          plan: {
            ...plan,
            providerSchedules: plan.providerSchedules.filter((s) => s.id !== id),
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'add_room': {
        const locationId = requireString(input, 'location_id');
        requireExists(plan.locations, locationId, 'location');
        const room: PlanRoom = {
          id: newId ?? randomUUID(),
          name: requireString(input, 'name'),
          locationId,
          type: requireString(input, 'type'),
        };
        return {
          plan: { ...plan, rooms: [...plan.rooms, room] },
          result: JSON.stringify({ id: room.id }),
        };
      }
      case 'remove_room': {
        const id = requireString(input, 'id');
        return {
          plan: { ...plan, rooms: plan.rooms.filter((r) => r.id !== id) },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'add_pinned_slot': {
        const serviceId = requireString(input, 'service_id');
        const locationId = requireString(input, 'location_id');
        requireExists(plan.services, serviceId, 'service');
        requireExists(plan.locations, locationId, 'location');
        const pin: PlanPinnedSlot = {
          id: newId ?? randomUUID(),
          serviceId,
          locationId,
          start: requireString(input, 'start'),
          end: requireString(input, 'end'),
          providerId: optionalString(input, 'provider_id'),
          roomId: optionalString(input, 'room_id'),
        };
        return {
          plan: { ...plan, pinnedSlots: [...plan.pinnedSlots, pin] },
          result: JSON.stringify({ id: pin.id }),
        };
      }
      case 'remove_pinned_slot': {
        const id = requireString(input, 'id');
        return {
          plan: { ...plan, pinnedSlots: plan.pinnedSlots.filter((p) => p.id !== id) },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'flag_unsupported': {
        const severity = requireString(input, 'severity');
        if (severity !== 'workaround' && severity !== 'blocking') {
          throw new Error(`severity must be "workaround" or "blocking"`);
        }
        return {
          plan: {
            ...plan,
            unsupported: [
              ...plan.unsupported,
              { description: requireString(input, 'description'), severity },
            ],
          },
          result: JSON.stringify({ ok: true }),
        };
      }
      case 'finalize_plan': {
        return {
          plan,
          result: JSON.stringify({ ok: true, readyToCommit: true }),
          finalize: {
            title: requireString(input, 'title'),
            summary: requireString(input, 'summary'),
          },
        };
      }
      default:
        return {
          plan,
          result: JSON.stringify({ error: `Unknown tool: ${name}` }),
          isError: true,
        };
    }
  } catch (err) {
    return {
      plan,
      result: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      isError: true,
    };
  }
}

// Reconstruct the plan state at every point in a persisted dialog. For
// each tool_use block, the id assigned during the original run is read
// from the corresponding tool_result and passed back into executeTool
// as `newId`; that keeps subsequent remove_* / add_qualification calls
// referring to the same ids they did originally.
function computePlanSnapshots(dialog: DialogMessage[]): SeedPlan[] {
  const snapshots: SeedPlan[] = [emptyPlan()];
  let plan: SeedPlan = emptyPlan();
  for (let i = 0; i < dialog.length; i++) {
    const msg = dialog[i]!;
    if (msg.role === 'assistant') {
      // Tool results for this turn arrive as the next user message's
      // tool_result blocks. Index by tool_use_id so we can match each
      // tool_use in this turn to the id it minted.
      const next = dialog[i + 1];
      const resultsById = new Map<string, { content: string; isError: boolean }>();
      if (next?.role === 'user') {
        for (const b of next.content) {
          if (b.type === 'tool_result') {
            resultsById.set(b.tool_use_id, {
              content: b.content,
              isError: b.is_error === true,
            });
          }
        }
      }
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        const result = resultsById.get(block.id);
        if (result?.isError) continue;
        let newId: string | undefined;
        if (result) {
          try {
            const parsed = JSON.parse(result.content) as { id?: unknown };
            if (typeof parsed.id === 'string') newId = parsed.id;
          } catch {
            // Non-JSON result → executor mints a fresh id, which is
            // fine for a display-only snapshot.
          }
        }
        const outcome = executeTool(plan, block.name, block.input, newId);
        plan = outcome.plan;
      }
    }
    snapshots.push(plan);
  }
  return snapshots;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

// Message surfaced when the read-only guard blocks a live-Anthropic
// action. Rendered on the client as a plain error so visitors see the
// GitHub link and understand what to do next.
function readOnlyMessage(): string {
  return `This deploy is view-only — new agentic conversations are disabled to protect the deployed Anthropic key. Fork the repo at ${githubUrl()} and add your own ANTHROPIC_API_KEY to run this end-to-end.`;
}

export async function createSetup(): Promise<{ id: string }> {
  if (isAgenticReadOnly()) throw new Error(readOnlyMessage());
  const db = await getDatabase();
  const id = randomUUID();
  const tag = generateTag(id);
  const starter: DialogMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: STARTER_ASSISTANT_MESSAGE }],
    timestamp: nowIso(),
  };
  await db.insert(agenticSetups).values({
    id,
    tag,
    status: 'in-progress',
    dialog: [starter],
    seedPlan: emptyPlan(),
  });
  revalidatePath(ROUTE_PATH);
  return { id };
}

export async function updateSetupTitle(
  setupId: string,
  title: string,
): Promise<void> {
  if (isAgenticReadOnly()) throw new Error(readOnlyMessage());
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error('Title cannot be empty');
  }
  const db = await getDatabase();
  const result = await db
    .update(agenticSetups)
    .set({ title: trimmed })
    .where(eq(agenticSetups.id, setupId));
  if ((result as { rowCount?: number }).rowCount === 0) {
    throw new Error(`No agentic setup found for id ${setupId}`);
  }
  revalidatePath(ROUTE_PATH);
  revalidatePath(`${ROUTE_PATH}/${setupId}`);
}

// Serializable fixture for one onboarding setup — the setup row itself
// plus every tag-scoped row across the scheduling tables. Structured so
// the eventual restore path just does `insert(table).values(rows).onConflictDoNothing()`
// per key. Timestamps come back as ISO strings so the JSON round-trips
// cleanly through a browser download.
export interface AgenticExportFixture {
  exportedAt: string;
  agenticSetups: unknown[];
  locations: unknown[];
  locationSchedules: unknown[];
  services: unknown[];
  servicesRoomRequirements: unknown[];
  providers: unknown[];
  providerQualifications: unknown[];
  providerSchedules: unknown[];
  rooms: unknown[];
  slots: unknown[];
}

// Dump one agentic setup and every downstream scheduling row that
// carries the same tag. Used by the Export button on the setups list
// to produce the fixture that the deploy's build-time seed will
// consume. Non-committed setups still produce a fixture — the
// scheduling arrays are just empty in that case (commit is what writes
// to them), but the setup row itself carries the full transcript for
// replay demos.
export async function exportSetup(
  setupId: string,
): Promise<AgenticExportFixture> {
  const db = await getDatabase();
  const [setup] = await db
    .select()
    .from(agenticSetups)
    .where(eq(agenticSetups.id, setupId));
  if (!setup) throw new Error(`No agentic setup found for id ${setupId}`);

  const tag = setup.tag;
  const [
    locationRows,
    locationScheduleRows,
    serviceRows,
    serviceRoomReqRows,
    providerRows,
    qualificationRows,
    providerScheduleRows,
    roomRows,
    slotRows,
  ] = await Promise.all([
    db.select().from(locations).where(eq(locations.tag, tag)),
    db.select().from(locationSchedules).where(eq(locationSchedules.tag, tag)),
    db.select().from(services).where(eq(services.tag, tag)),
    db.select().from(servicesRoomRequirements).where(eq(servicesRoomRequirements.tag, tag)),
    db.select().from(providers).where(eq(providers.tag, tag)),
    db.select().from(providerQualifications).where(eq(providerQualifications.tag, tag)),
    db.select().from(providerSchedules).where(eq(providerSchedules.tag, tag)),
    db.select().from(rooms).where(eq(rooms.tag, tag)),
    db.select().from(slots).where(eq(slots.tag, tag)),
  ]);

  return {
    exportedAt: nowIso(),
    agenticSetups: [
      {
        ...setup,
        createdAt: setup.createdAt.toISOString(),
        committedAt: setup.committedAt?.toISOString() ?? null,
      },
    ],
    locations: locationRows,
    locationSchedules: locationScheduleRows,
    services: serviceRows,
    servicesRoomRequirements: serviceRoomReqRows,
    providers: providerRows,
    providerQualifications: qualificationRows,
    providerSchedules: providerScheduleRows,
    rooms: roomRows,
    slots: slotRows,
  };
}

export async function listSetups(): Promise<AgenticSetupSummary[]> {
  const db = await getDatabase();
  const rows = await db
    .select({
      id: agenticSetups.id,
      tag: agenticSetups.tag,
      title: agenticSetups.title,
      status: agenticSetups.status,
      createdAt: agenticSetups.createdAt,
      committedAt: agenticSetups.committedAt,
    })
    .from(agenticSetups)
    .orderBy(desc(agenticSetups.createdAt));
  return rows.map((r) => ({
    id: r.id,
    tag: r.tag,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    committedAt: r.committedAt?.toISOString() ?? null,
  }));
}

export async function getSetup(id: string): Promise<AgenticSetupDetail | null> {
  const db = await getDatabase();
  const [row] = await db.select().from(agenticSetups).where(eq(agenticSetups.id, id));
  if (!row) return null;
  const dialog = normalizeDialog(row.dialog);
  return {
    id: row.id,
    tag: row.tag,
    title: row.title,
    status: row.status,
    useCaseSummary: row.useCaseSummary,
    dialog,
    planSnapshots: computePlanSnapshots(dialog),
    seedPlan: (row.seedPlan as SeedPlan | null) ?? emptyPlan(),
    createdAt: row.createdAt.toISOString(),
    committedAt: row.committedAt?.toISOString() ?? null,
  };
}

// Convert stored dialog messages to the SDK's MessageParam shape.
function toApiMessages(dialog: DialogMessage[]): Anthropic.MessageParam[] {
  return dialog.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use')
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: b.content,
        ...(b.is_error ? { is_error: true } : {}),
      };
    }),
  }));
}

export async function sendUserMessage(
  setupId: string,
  userMessage: string,
): Promise<{ dialog: DialogMessage[]; seedPlan: SeedPlan; title: string | null }> {
  if (isAgenticReadOnly()) throw new Error(readOnlyMessage());
  if (!userMessage.trim()) {
    throw new Error('Cannot send an empty message');
  }
  const db = await getDatabase();
  const [setup] = await db
    .select()
    .from(agenticSetups)
    .where(eq(agenticSetups.id, setupId));
  if (!setup) throw new Error(`No agentic setup found for id ${setupId}`);
  if (setup.status !== 'in-progress') {
    throw new Error(
      `Setup ${setupId} is ${setup.status}; messages can only be added while in-progress`,
    );
  }

  const existing = normalizeDialog(setup.dialog);
  let plan: SeedPlan = (setup.seedPlan as SeedPlan | null) ?? emptyPlan();
  let title: string | null = setup.title;
  let useCaseSummary: string | null = setup.useCaseSummary;

  const dialog: DialogMessage[] = [
    ...existing,
    {
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
      timestamp: nowIso(),
    },
  ];

  // Tool-loop: keep calling the model, executing any tool_uses it emits,
  // and feeding tool_results back, until it stops calling tools (or we
  // hit the iteration cap as a runaway guard).
  for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
      max_tokens: MAX_TOKENS_PER_TURN,
      system: buildSystemPrompt(),
      tools: TOOL_DEFINITIONS,
      messages: toApiMessages(dialog),
    });

    const assistantBlocks: StoredContentBlock[] = response.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use')
        return {
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input: (b.input ?? {}) as Record<string, unknown>,
        };
      // The API can return other block types (server_tool_use, etc.); we
      // don't opt into any of them, so this is a safe swallow.
      return { type: 'text', text: '' };
    });
    dialog.push({
      role: 'assistant',
      content: assistantBlocks,
      timestamp: nowIso(),
    });

    // Always process any tool_use blocks the response contained, even
    // if stop_reason isn't 'tool_use'. The model can emit a valid
    // burst of tool_use blocks and then hit max_tokens before finishing
    // its text; the tool_use blocks are still complete and expect
    // results. Persisting the assistant turn without their tool_results
    // corrupts the dialog — every future API call fails with a 400.
    const toolResults: StoredContentBlock[] = [];
    for (const block of assistantBlocks) {
      if (block.type !== 'tool_use') continue;
      const outcome = executeTool(plan, block.name, block.input);
      plan = outcome.plan;
      if (outcome.finalize) {
        title = outcome.finalize.title;
        useCaseSummary = outcome.finalize.summary;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: outcome.result,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    if (toolResults.length > 0) {
      dialog.push({
        role: 'user',
        content: toolResults,
        timestamp: nowIso(),
      });
    }

    // Whether to make another round-trip. Only continue if the model
    // explicitly signaled it wanted more tool calls — otherwise it's
    // done (natural end_turn) or was truncated (max_tokens) and the
    // client should stop.
    if (response.stop_reason !== 'tool_use') break;
  }

  await db
    .update(agenticSetups)
    .set({
      dialog,
      seedPlan: plan,
      title,
      useCaseSummary,
    })
    .where(eq(agenticSetups.id, setupId));
  revalidatePath(`${ROUTE_PATH}/${setupId}`);

  return { dialog, seedPlan: plan, title };
}

// ─── Commit ──────────────────────────────────────────────────────────────────
//
// Promote the setup's seed_plan into the scoped scheduling tables so the
// existing calendar UI can render it. All inserts use `tag = setup.tag`,
// matching how the other scenario pages already scope their reads. Runs
// inside a Drizzle transaction so a mid-write failure rolls back cleanly.

export async function commitSetup(
  setupId: string,
): Promise<{ tag: string }> {
  if (isAgenticReadOnly()) throw new Error(readOnlyMessage());
  const db = await getDatabase();
  const [setup] = await db
    .select()
    .from(agenticSetups)
    .where(eq(agenticSetups.id, setupId));
  if (!setup) throw new Error(`No agentic setup found for id ${setupId}`);
  if (setup.status === 'committed') {
    throw new Error(`Setup ${setupId} is already committed`);
  }
  const plan = (setup.seedPlan as SeedPlan | null) ?? emptyPlan();
  const tag = setup.tag;

  if (plan.locations.length === 0 && plan.services.length === 0) {
    throw new Error(
      'Nothing to commit — the seed plan has no locations or services recorded yet.',
    );
  }

  await db.transaction(async (tx) => {
    if (plan.locations.length) {
      await tx.insert(locations).values(
        plan.locations.map((l) => ({
          id: l.id,
          name: l.name,
          timezone: l.timezone ?? null,
          tag,
        })),
      );
    }
    if (plan.locationSchedules.length) {
      await tx.insert(locationSchedules).values(
        plan.locationSchedules.map((s) => ({
          id: s.id,
          locationId: s.locationId,
          start: s.start,
          end: s.end,
          capacity: s.capacity ?? null,
          tag,
        })),
      );
    }
    if (plan.services.length) {
      await tx.insert(services).values(
        plan.services.map((s) => ({
          id: s.id,
          name: s.name,
          durationMinutes: s.durationMinutes,
          requiresProvider: s.requiresProvider,
          requiresRoom: s.requiresRoom ?? false,
          bookingCadenceMinutes: s.bookingCadenceMinutes ?? null,
          tag,
        })),
      );
    }
    if (plan.providers.length) {
      await tx.insert(providers).values(
        plan.providers.map((p) => ({ id: p.id, name: p.name, tag })),
      );
    }
    if (plan.qualifications.length) {
      await tx.insert(providerQualifications).values(
        plan.qualifications.map((q) => ({
          providerId: q.providerId,
          serviceId: q.serviceId,
          tag,
        })),
      );
    }
    if (plan.providerSchedules.length) {
      await tx.insert(providerSchedules).values(
        plan.providerSchedules.map((s) => ({
          id: s.id,
          providerId: s.providerId,
          locationId: s.locationId,
          start: s.start,
          end: s.end,
          tag,
        })),
      );
    }
    if (plan.rooms.length) {
      await tx.insert(rooms).values(
        plan.rooms.map((r) => ({
          id: r.id,
          name: r.name,
          locationId: r.locationId,
          type: r.type,
          tag,
        })),
      );
    }
    if (plan.serviceRoomRequirements.length) {
      await tx.insert(servicesRoomRequirements).values(
        plan.serviceRoomRequirements.map((r) => ({
          serviceId: r.serviceId,
          roomType: r.roomType,
          tag,
        })),
      );
    }
    if (plan.pinnedSlots.length) {
      await tx.insert(slots).values(
        plan.pinnedSlots.map((p) => ({
          id: p.id,
          providerId: p.providerId ?? null,
          locationId: p.locationId,
          serviceId: p.serviceId,
          roomId: p.roomId ?? null,
          start: p.start,
          end: p.end,
          status: 'busy',
          tag,
        })),
      );
    }
    await tx
      .update(agenticSetups)
      .set({ status: 'committed', committedAt: new Date() })
      .where(eq(agenticSetups.id, setupId));
  });

  revalidatePath(`${ROUTE_PATH}/${setupId}`);
  revalidatePath(ROUTE_PATH);
  return { tag };
}

