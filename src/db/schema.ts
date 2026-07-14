// Drizzle table definitions for sched-linx. Mirrors the canonical model
// in src/model.ts. ID columns are plain `text` — TypeScript brands carry
// no runtime weight, so storage is just a string; the repository layer
// re-applies the brands at the boundary. Time columns are also `text`
// (ISO 8601 UTC, matching the Instant brand) to sidestep driver/dialect
// quirks around timestamp serialization; SQL-level time arithmetic isn't
// needed at the v1 algorithm layer.

import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const providers = pgTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tag: text('tag'),
});

export const services = pgTable('services', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  requiresRoom: boolean('requires_room').notNull().default(true),
  // When true (the default), booking this service requires a specific
  // provider assignment and time is gated by provider schedules. When
  // false, the service is location-scheduled — no provider is tied to
  // the booking and availability is gated by location capacity +
  // (optionally) shared-room contention. Urgent care is the canonical
  // requiresProvider=false case.
  requiresProvider: boolean('requires_provider').notNull().default(true),
  // How often a new appointment can start, in minutes. Distinct from
  // durationMinutes: an urgent care that offers a 15-min service with a
  // 10-min cadence lets 6 bookings begin per hour, with 2 overlapping
  // at peak — the practice's advertised booking pattern. Null defaults
  // to "cadence equals duration", the historical behavior. Overrides
  // any request-level `granularityMinutes` when set: the practice's
  // offered cadence is authoritative, not the caller's ask.
  bookingCadenceMinutes: integer('booking_cadence_minutes'),
  tag: text('tag'),
});

export const locations = pgTable('locations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // IANA timezone identifier (e.g. "America/Los_Angeles"). Optional
  // because pre-slice-2 scenarios were seeded UTC-only; anything
  // committed via agentic onboarding should carry a value. Consumed by
  // the calendar for display rendering; the scheduler ignores it and
  // stays in UTC Instants.
  timezone: text('timezone'),
  tag: text('tag'),
});

// Materialized (locationId, start, end, capacity) windows. Different
// shifts get different rows; null capacity = doesn't participate in
// location-based scheduling.
export const locationSchedules = pgTable('location_schedules', {
  id: text('id').primaryKey(),
  locationId: text('location_id')
    .notNull()
    .references(() => locations.id),
  start: text('start').notNull(),
  end: text('end').notNull(),
  capacity: integer('capacity'),
  tag: text('tag'),
});

export const providerQualifications = pgTable(
  'provider_qualifications',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    tag: text('tag'),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.serviceId] })],
);

export const providerSchedules = pgTable('provider_schedules', {
  id: text('id').primaryKey(),
  providerId: text('provider_id')
    .notNull()
    .references(() => providers.id),
  locationId: text('location_id')
    .notNull()
    .references(() => locations.id),
  start: text('start').notNull(),
  end: text('end').notNull(),
  tag: text('tag'),
});

export const slots = pgTable('slots', {
  id: text('id').primaryKey(),
  // Nullable: location-scheduled services (requiresProvider=false)
  // book slots without a specific provider. Only set for
  // provider-scheduled bookings.
  providerId: text('provider_id').references(() => providers.id),
  locationId: text('location_id')
    .notNull()
    .references(() => locations.id),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  roomId: text('room_id').references(() => rooms.id),
  start: text('start').notNull(),
  end: text('end').notNull(),
  // FHIR-aligned vocabulary: 'free' (open) | 'busy' (active booking) |
  // 'canceled' (former booking, kept for history; maps to FHIR's
  // entered-in-error at the integration boundary). Only 'busy' rows
  // participate in scheduling decisions.
  status: text('status').notNull().default('free'),
  tag: text('tag'),
});

export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(), // default to uuid in repo layer,
  name: text('name').notNull(),
  locationId: text('location_id')
    .notNull()
    .references(() => locations.id),
  type: text('type').notNull(),
  tag: text('tag'),
});

// Which room types satisfy a service's room requirement. Three states,
// expressed via the combination of services.requiresRoom and this junction:
//   - requiresRoom=false                          → no room needed (telehealth)
//   - requiresRoom=true, zero rows here for svc   → any room type works
//   - requiresRoom=true, N rows here for svc      → any one of those N types
//     satisfies the requirement (OR, not AND — a booking occupies one room
//     at a time, so AND would be nonsensical)
//
// roomType is free text, not a FK to a room_types lookup. Typo discipline
// lives at the TS layer for now; revisit if the type vocabulary grows.
export const servicesRoomRequirements = pgTable(
  'services_room_requirements',
  {
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    roomType: text('room_type').notNull(),
    tag: text('tag'),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.roomType] })],
);

// Persisted record of an agentic-onboarding session — the conversation
// between a user and the planning agent, plus the structured seed plan
// the agent produced.
//
// `tag` is the scoping label for any scheduling-table rows (providers,
// services, rooms, schedules, slots, etc.) seeded by this setup. It's
// what the existing tag-aware queries already use to isolate one
// scenario's data from another. Kept distinct from `id` so the primary
// key stays a stable internal identifier while the tag can be a more
// human-friendly string used at the seed-application boundary.
// Treat `tag` as immutable after commit — renaming it post-seed would
// orphan the rows that were written with the old value.
//
// `dialog` and `seed_plan` are stored as jsonb so the shape can evolve
// without per-change migrations. Strict types are applied at the
// repository/action boundary.
export const agenticSetups = pgTable('agentic_setups', {
  id: text('id').primaryKey(),
  tag: text('tag').notNull().unique(),
  title: text('title'),
  useCaseSummary: text('use_case_summary'),
  // 'in-progress' | 'committed' | 'abandoned'. Kept as free text for
  // now; constrain with an enum table or check constraint later if we
  // grow more states.
  status: text('status').notNull().default('in-progress'),
  // Array of conversation messages (role, content, timestamp, optional
  // tool_calls / tool_results). Mirrors Anthropic's Messages API shape
  // so a stored dialog can be replayed through the SDK without
  // translation. Defaulted to '[]' so a newly-inserted row is
  // immediately usable.
  dialog: jsonb('dialog').notNull().default([]),
  // The structured plan the agent has emitted via tool calls — provider
  // roster, services, rooms, schedules, pinned slots. Null until the
  // agent has produced any of it. Materialized into the scheduling
  // tables (with `tag = setup.id`) at commit time.
  seedPlan: jsonb('seed_plan'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  committedAt: timestamp('committed_at'),
});


// ─── Relations ───────────────────────────────────────────────────────────────

export const providersRelations = relations(providers, ({ many }) => ({
  qualifications: many(providerQualifications),
  schedules: many(providerSchedules),
  slots: many(slots),
}));

export const providerQualificationsRelations = relations(
  providerQualifications,
  ({ one }) => ({
    provider: one(providers, {
      fields: [providerQualifications.providerId],
      references: [providers.id],
    }),
    service: one(services, {
      fields: [providerQualifications.serviceId],
      references: [services.id],
    }),
  }),
);

export const providerSchedulesRelations = relations(
  providerSchedules,
  ({ one }) => ({
    provider: one(providers, {
      fields: [providerSchedules.providerId],
      references: [providers.id],
    }),
    location: one(locations, {
      fields: [providerSchedules.locationId],
      references: [locations.id],
    }),
  }),
);

export const servicesRelations = relations(services, ({ many }) => ({
  qualifications: many(providerQualifications),
  slots: many(slots),
  roomRequirements: many(servicesRoomRequirements),
}));

export const slotsRelations = relations(slots, ({ one }) => ({
  provider: one(providers, {
    fields: [slots.providerId],
    references: [providers.id],
  }),
  service: one(services, {
    fields: [slots.serviceId],
    references: [services.id],
  }),
  location: one(locations, {
    fields: [slots.locationId],
    references: [locations.id],
  }),
  room: one(rooms, {
    fields: [slots.roomId],
    references: [rooms.id],
  }),
}));

export const locationsRelations = relations(locations, ({ many }) => ({
  // Renamed from `schedules` to disambiguate now that location_schedules
  // exists too.
  providerSchedules: many(providerSchedules),
  locationSchedules: many(locationSchedules),
  slots: many(slots),
  rooms: many(rooms),
}));

export const locationSchedulesRelations = relations(
  locationSchedules,
  ({ one }) => ({
    location: one(locations, {
      fields: [locationSchedules.locationId],
      references: [locations.id],
    }),
  }),
);

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  location: one(locations, {
    fields: [rooms.locationId],
    references: [locations.id],
  }),
  slots: many(slots),
}));

export const servicesRoomRequirementsRelations = relations(
  servicesRoomRequirements,
  ({ one }) => ({
    service: one(services, {
      fields: [servicesRoomRequirements.serviceId],
      references: [services.id],
    }),
  }),
);
