// Canonical data model for sched-linx. Single file by design — split per
// entity only when the surface area earns it.
//
// The "Slot is the booking" model: every persisted Slot row IS a booking
// (status='busy') or a former booking (status='canceled'). There is no
// separate Appointment table; the slot itself carries the lifecycle.
// Patient identity is intentionally absent at this layer — bookings are
// anonymous in the canonical model. If/when a vendor integration layer
// is added (e.g. an adapter to a FHIR-shaped EHR), patient identity
// reattaches at that adapter boundary; the canonical core stays
// patient-anonymous.

type Brand<K, T> = K & { readonly __brand: T };

export type ProviderId = Brand<string, 'ProviderId'>;
export type ServiceId = Brand<string, 'ServiceId'>;
export type LocationId = Brand<string, 'LocationId'>;
export type ProviderScheduleId = Brand<string, 'ProviderScheduleId'>;
export type LocationScheduleId = Brand<string, 'LocationScheduleId'>;
export type SlotId = Brand<string, 'SlotId'>;
export type RoomId = Brand<string, 'RoomId'>;

// ISO 8601 timestamp string in UTC (e.g. "2026-05-25T14:30:00Z"). The brand
// is unenforceable at runtime — callers must construct from a valid ISO UTC
// string. Keeping time as a branded string avoids the timezone footguns of
// `Date` while preserving cheap equality and serialization.
export type Instant = Brand<string, 'Instant'>;

// Slot lifecycle. FHIR-aligned vocabulary: `free` (an open slot, available
// to be booked), `busy` (an active booking — what the matrix treats as a
// pin), `canceled` (a former booking, kept for history; mapped to FHIR's
// `entered-in-error` at the integration boundary). Only `busy` slots
// participate in scheduling decisions.
export type SlotStatus = 'free' | 'busy' | 'canceled';

export interface Provider {
  id: ProviderId;
  name: string;
}

export interface Service {
  id: ServiceId;
  name: string;
  durationMinutes: number;
  // If true (the default), the service requires a specific provider
  // assignment and availability is gated by provider schedules. If
  // false, the service is location-scheduled: no provider is tied to
  // the booking, and availability is gated by location capacity +
  // optional shared-room contention. Urgent care is the canonical
  // requiresProvider=false case.
  requiresProvider: boolean;
  // If true, the service requires a room that meets its
  // ServiceRoomRequirement(s). Independent of requiresProvider — a
  // location-scheduled service may or may not need a room.
  requiresRoom?: boolean;
  // How often a new appointment can start, in minutes. Distinct from
  // durationMinutes: a service with duration=15 and cadence=10 lets 6
  // bookings begin per hour, with peak concurrency of 2. Undefined
  // means "no configured cadence — fall through to caller / default."
  //
  // Prototype precedence: request.granularityMinutes wins over this
  // field. That's inverted from what a production system would want
  // (the practice's configured cadence should be authoritative), but
  // it keeps the demo's UI cadence dropdown honest — flipping it lets
  // the visualizer explore the same service under different cadences.
  bookingCadenceMinutes?: number;
}

// Composite (providerId, serviceId) is the natural key. No surrogate id
// until persistence demands one.
export interface ProviderQualification {
  providerId: ProviderId;
  serviceId: ServiceId;
}

export interface Location {
  id: LocationId;
  name: string;
  // IANA timezone identifier for display. Optional — the scheduler
  // works in UTC Instants and doesn't consult this field. UI surfaces
  // (calendar, admin schedule editor) render dates/times in this
  // timezone when set.
  timezone?: string;
}

// Materialized (locationId, start, end, capacity) window. Different
// shifts get different rows; undefined capacity = doesn't participate
// in location-based scheduling.
export interface LocationSchedule {
  id: LocationScheduleId;
  locationId: LocationId;
  start: Instant;
  end: Instant;
  capacity?: number;
}

// One availability window. A provider's full schedule is the union of all
// their ProviderSchedule rows; we do not model recurrence as a first-class
// concept — recurrence (if needed later) materializes into concrete rows.
export interface ProviderSchedule {
  id: ProviderScheduleId;
  providerId: ProviderId;
  locationId: LocationId;
  start: Instant;
  end: Instant;
}

// The unit of booking. A persisted slot with status='busy' is an active
// booking — what the matrix algorithm treats as a pin. status='canceled'
// rows are history (kept for audits and reshuffle provenance). status='free'
// is the default for any row that isn't actively booked; the prototype
// doesn't pre-materialize free slot inventory, so persisted slots are
// almost always 'busy' or 'canceled' in practice.
export interface Slot {
  id: SlotId;
  // Undefined for slots booked against a location-scheduled service
  // (no specific provider is tied to the booking). Always set for
  // provider-scheduled bookings.
  providerId?: ProviderId;
  locationId: LocationId;
  serviceId: ServiceId;
  start: Instant;
  end: Instant;
  status: SlotStatus;
  roomId?: RoomId;
}

// A Slot before DLX selects it: same shape, no id, no status (status is
// a persisted-row concept). Each candidate is a row in the matrix;
// selected candidates are persisted (becoming Slots with status='busy');
// unselected candidates are discarded.
export type SlotCandidate = Omit<Slot, 'id' | 'status'>;

// DTO at the schedule(...) boundary; never persisted. The window bounds
// candidate-slot generation: the request will be filled by a slot whose
// [start, end) lies within [window.start, window.end). Anonymous — no
// patient identity at this layer.
//
// Optional `providerId` constrains candidates to that specific provider.
// Useful when a UI surface (e.g., calendar grid) lets the user click a
// specific (provider, time) cell — we don't want the picker silently
// choosing a different provider just because the time matches multiple
// qualified candidates. Omitting it leaves provider selection up to the
// picker as before.
//
// Optional `granularityMinutes` controls the increment at which
// candidate start times are enumerated within the window. Defaults to 15
// min when omitted. UIs that show a finer- or coarser-grained grid
// should pass their cadence here so the backend's enumerated candidates
// line up with the cells the user can click; otherwise a tight-window
// click may snap past the requested start and produce no candidates.
export interface BookingRequest {
  serviceId: ServiceId;
  window: { start: Instant; end: Instant };
  providerId?: ProviderId;
  // Optional location constraint. Set → picker restricts to this
  // location (in-person walk-in at a specific clinic). Unset → picker
  // routes across all locations offering the service using the
  // configured routing strategy (default: most-headroom). Same
  // pattern as providerId.
  locationId?: LocationId;
  granularityMinutes?: number;
}

export interface Room {
  id: RoomId;
  name: string;
  locationId: LocationId;
  type: string;
}

export interface ServiceRoomRequirement {
  serviceId: ServiceId;
  roomType: string;
}
