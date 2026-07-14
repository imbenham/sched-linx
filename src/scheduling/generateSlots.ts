import type {
  BookingRequest,
  Instant,
  Location,
  LocationSchedule,
  ProviderQualification,
  ProviderSchedule,
  Room,
  Service,
  ServiceRoomRequirement,
  SlotCandidate,
} from '../model';

const DEFAULT_GRANULARITY_MINUTES = 15;
const MS_PER_MINUTE = 60_000;

const toEpoch = (i: Instant): number => Date.parse(i);
const fromEpoch = (ms: number): Instant =>
  new Date(ms).toISOString() as Instant;

// Which rooms are eligible for a given service, mirroring the matrix
// layer's understanding. Exported so both candidate generation
// (provider-scheduled path) and the location-scheduled picker can share
// one definition of "eligible" without drifting.
export function eligibleRoomsFor(
  serviceId: string,
  rooms: Room[],
  requirements: ServiceRoomRequirement[],
): Room[] {
  const reqRows = requirements.filter((rr) => rr.serviceId === serviceId);
  if (reqRows.length === 0) return rooms;
  return rooms.filter((r) => reqRows.some((rr) => rr.roomType === r.type));
}

export interface GenerateSlotsContext {
  services: Service[];
  qualifications: ProviderQualification[];
  schedules: ProviderSchedule[];
  rooms?: Room[];
  servicesRoomRequirements?: ServiceRoomRequirement[];
  // Present when the context includes location-scheduled services.
  // Location-based picker paths consult these instead of provider
  // schedules for time-window eligibility.
  locations?: Location[];
  locationSchedules?: LocationSchedule[];
}


// Generate every candidate Slot that could satisfy `request`. Pure function:
// no DLX, no awareness of pinned slots — the matrix builder handles
// conflict detection via event intervals. The caller maps this over each
// request to assemble the row set for the matrix.
//
// Cadence precedence (prototype posture): request.granularityMinutes
// wins, then service.bookingCadenceMinutes as a fallback, then the
// 15-min default. This inversion is deliberate — the UI dropdown is
// how we demo the substrate's flexibility, and letting the request
// override the service's advertised cadence keeps that dropdown
// authoritative. A production build would flip the precedence back so
// the service's configured cadence is the source of truth and callers
// can't loosen it. `request.providerId`, if set, narrows candidates to
// that provider only.
export function generateSlots(
  request: BookingRequest,
  ctx: GenerateSlotsContext,
): SlotCandidate[] {
  const service = ctx.services.find((s) => s.id === request.serviceId);
  if (!service) return [];
  const durationMs = service.durationMinutes * MS_PER_MINUTE;

  const cadenceMinutes =
    request.granularityMinutes ??
    service.bookingCadenceMinutes ??
    DEFAULT_GRANULARITY_MINUTES;
  const granularityMs = cadenceMinutes * MS_PER_MINUTE;

  const qualifiedProviderIds = new Set(
    ctx.qualifications
      .filter((q) => q.serviceId === request.serviceId)
      .map((q) => q.providerId),
  );

  const requestStart = toEpoch(request.window.start);
  const requestEnd = toEpoch(request.window.end);

  let candidates: SlotCandidate[] = [];

  for (const schedule of ctx.schedules) {
    if (!qualifiedProviderIds.has(schedule.providerId)) continue;
    // Optional provider constraint — when set, only candidates for that
    // exact provider are generated (e.g. a calendar UI clicking a
    // specific (provider, time) cell).
    if (request.providerId && schedule.providerId !== request.providerId) continue;

    const windowStart = Math.max(toEpoch(schedule.start), requestStart);
    const windowEnd = Math.min(toEpoch(schedule.end), requestEnd);

    // Snap slot starts to wall-clock granularity boundaries so candidates
    // land on intuitive times (e.g., :00/:15/:30/:45 for 15-min granularity)
    // independent of where the window starts.
    const firstStart =
      Math.ceil(windowStart / granularityMs) * granularityMs;

    for (
      let start = firstStart;
      start + durationMs <= windowEnd;
      start += granularityMs
    ) {
      candidates.push({
        providerId: schedule.providerId,
        locationId: schedule.locationId,
        serviceId: request.serviceId,
        start: fromEpoch(start),
        end: fromEpoch(start + durationMs),
      });
    }
  }

  const { rooms, services, servicesRoomRequirements } = ctx;


  const serviceRequiresRoom = services.find((s) => s.id === request.serviceId)?.requiresRoom ?? false;

  if (!serviceRequiresRoom) {
    return candidates;
  }

  const eligible = eligibleRoomsFor(
    request.serviceId,
    rooms ?? [],
    servicesRoomRequirements ?? [],
  );

  if (eligible.length === 0) return [];  // requires a room but none available → infeasible

  return candidates.flatMap(c => eligible.map(r => ({ ...c, roomId: r.id })));
}
