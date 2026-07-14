// Seed a representative scheduling scenario for development and the
// visualizer. Destructive — wipes all tables in reverse-FK order before
// repopulating, so reseeding gives a clean known state every time.
//
// The scenario is hand-picked to surface interesting algorithm behavior:
//   - Three providers with overlapping qualifications (mix of general
//     practice and specialty) so picker has real choice for most slots.
//   - Three services of different durations (30/45/60 min) so event
//     intervals get non-trivial granularity.
//   - Four pre-existing busy slots creating contested time bands — enough
//     that pickProvider sometimes succeeds, sometimes needs reshuffle,
//     sometimes infeasible.

import {
  agenticSetups,
  locations,
  locationSchedules,
  providerQualifications,
  providers,
  providerSchedules,
  rooms,
  services,
  servicesRoomRequirements,
  slots,
} from './schema';
import type { Database } from './client';
import { eq } from 'drizzle-orm';

export interface SeedOptions {
  /** ISO date (YYYY-MM-DD) the scenario takes place on. Defaults to today (UTC). */
  date?: string;
  tag?: string; // for easier debugging and test data inspection; not used by the app logic
  useRooms?: boolean; // if false, don't seed any rooms or room requirements (for testing telehealth scenarios)
}

const pad = (n: number) => String(n).padStart(2, '0');

const makeId = (id: string, tag?: string) => (tag ? `${id}-${tag}` : id);

export async function seedScenario(
  db: Database,
  options: SeedOptions = {},
): Promise<void> {
  const date =
    options.date ?? new Date().toISOString().slice(0, 10);
  const at = (h: number, m = 0): string =>
    `${date}T${pad(h)}:${pad(m)}:00.000Z`;
  const { tag, useRooms = true } = options;

  // Wipe in reverse-FK order so foreign-key constraints don't bite.
  // Dependency order (leaf → root):
  //   slots → {providers, locations, services, rooms}
  //   providerQualifications → {providers, services}
  //   providerSchedules → {providers, locations}
  //   servicesRoomRequirements → {services}
  //   rooms → {locations}
  //   services, providers — leaves
  //   locations — root
  if (tag) {
    await db.delete(slots).where(eq(slots.tag, tag));
    await db.delete(providerQualifications).where(eq(providerQualifications.tag, tag));
    await db.delete(providerSchedules).where(eq(providerSchedules.tag, tag));
    await db.delete(locationSchedules).where(eq(locationSchedules.tag, tag));
    await db.delete(servicesRoomRequirements).where(eq(servicesRoomRequirements.tag, tag));
    await db.delete(rooms).where(eq(rooms.tag, tag));
    await db.delete(services).where(eq(services.tag, tag));
    await db.delete(providers).where(eq(providers.tag, tag));
    await db.delete(locations).where(eq(locations.tag, tag));
  } else {
    await db.delete(slots);
    await db.delete(providerQualifications);
    await db.delete(providerSchedules);
    await db.delete(locationSchedules);
    await db.delete(servicesRoomRequirements);
    await db.delete(rooms);
    await db.delete(services);
    await db.delete(providers);
    await db.delete(locations);
  }
  await db.insert(locations).values({
    id: makeId('main-clinic', tag),
    name: 'Main Clinic',
    tag,
  });

  await db.insert(providers).values([
    { id: makeId('hawkeye', tag), name: 'Dr. Hawkeye Pierce', tag },
    { id: makeId('nick', tag), name: 'Dr. Nick Riviera', tag },
    { id: makeId('quinn', tag), name: 'Dr. Michaela Quinn', tag },
  ]);

  await db.insert(services).values([
    { id: makeId('checkup', tag), name: 'Checkup', durationMinutes: 30, requiresRoom: false, tag },
    { id: makeId('consult', tag), name: 'Consult', durationMinutes: 45, requiresRoom: false, tag },
    { id: makeId('imaging', tag), name: 'Imaging', durationMinutes: 60, requiresRoom: useRooms && true, tag },
  ]);

  // Hawkeye and Nick are general practice (checkup + consult). Quinn is
  // the specialist (consult + imaging). Only Quinn does imaging — this
  // creates forced-pin scenarios.
  await db.insert(providerQualifications).values([
    { providerId: makeId('hawkeye', tag), serviceId: makeId('checkup', tag), tag },
    { providerId: makeId('hawkeye', tag), serviceId: makeId('consult', tag), tag },
    { providerId: makeId('nick', tag), serviceId: makeId('checkup', tag), tag },
    { providerId: makeId('nick', tag), serviceId: makeId('consult', tag), tag },
    { providerId: makeId('quinn', tag), serviceId: makeId('consult', tag), tag },
    { providerId: makeId('quinn', tag), serviceId: makeId('imaging', tag), tag },
  ]);

  // Everyone's at the main clinic 8am–5pm UTC.
  await db.insert(providerSchedules).values([
    {
      id: makeId('sched-hawkeye', tag),
      providerId: makeId('hawkeye', tag),
      locationId: makeId('main-clinic', tag),
      start: at(8),
      end: at(17),
      tag,
    },
    {
      id: makeId('sched-nick', tag),
      providerId: makeId('nick', tag),
      locationId: makeId('main-clinic', tag),
      start: at(8),
      end: at(17),
      tag,
    },
    {
      id: makeId('sched-quinn', tag),
      providerId: makeId('quinn', tag),
      locationId: makeId('main-clinic', tag),
      start: at(8),
      end: at(17),
      tag,
    },
  ]);
  if (useRooms) {
    await db.insert(rooms).values([
      {
        id: makeId('room1', tag),
        name: 'Room 1',
        locationId: makeId('main-clinic', tag),
        type: 'exam',
        tag,
      },
      {
        id: makeId('room2', tag),
        name: 'Room 2',
        locationId: makeId('main-clinic', tag),
        type: 'imaging',
        tag,
      },
    ]);
    await db.insert(servicesRoomRequirements).values([
      {
        serviceId: makeId('imaging', tag),
        roomType: 'imaging',
        tag,
      },
    ]);
    await db.insert(providers).values([
      {
        id: makeId('hauser', tag),
        name: 'Dr. Doogie Hauser',
        tag,
      }
    ]);
    await db.insert(providerQualifications).values([
      { providerId: makeId('hauser', tag), serviceId: makeId('imaging', tag), tag },
    ]);
    await db.insert(providerSchedules).values([
    {
      id: makeId('sched-hauser', tag),
      providerId: makeId('hauser', tag),
      locationId: makeId('main-clinic', tag),
      start: at(8),
      end: at(17),
      tag,
    },
    /*{
      id: makeId('sched-hauser-2', tag),
      providerId: makeId('hauser', tag),
      locationId: makeId('main-clinic', tag),
      start: at(13),
      end: at(17),
      tag,
    },*/
  ]);

  }

  // Four pre-existing busy slots engineered for visualizer narrative:
  //   - 9:00 Nick/checkup    → 9:00 checkups now have only Hawkeye available
  //   - 10:00 Quinn/imaging  → 10:00 imaging is infeasible (Quinn's the only one)
  //   - 11:00 Hawkeye/consult → 11:00 consults still have Nick and Quinn
  //   - 14:00 Hawkeye/checkup → afternoon checkup slot taken; reshuffle bait
  await db.insert(slots).values([
    {
      id: makeId('pin-nick-9', tag),
      providerId: makeId('nick', tag),
      locationId: makeId('main-clinic', tag),
      serviceId: makeId('checkup', tag),
      start: at(9),
      end: at(9, 30),
      status: 'busy',
      tag,
    },
    {
      id: makeId('pin-quinn-10', tag),
      providerId: makeId('quinn', tag),
      locationId: makeId('main-clinic', tag),
      serviceId: makeId('imaging', tag),
      start: at(10),
      end: at(11),
      status: 'busy',
      // Imaging requires the imaging room (when useRooms is true), so a
      // realistic pinned imaging slot should also be holding that room.
      // Without this, the room is silently "free" at 10am even though
      // the only imaging-qualified provider is busy in it.
      roomId: useRooms ? makeId('room2', tag) : undefined,
      tag,
    },
    {
      id: makeId('pin-hawkeye-11', tag),
      providerId: makeId('hawkeye', tag),
      locationId: makeId('main-clinic', tag),
      serviceId: makeId('consult', tag),
      start: at(11),
      end: at(11, 45),
      status: 'busy',
      tag,
    },
    {
      id: makeId('pin-hawkeye-14', tag),
      providerId: makeId('hawkeye', tag),
      locationId: makeId('main-clinic', tag),
      serviceId: makeId('checkup', tag),
      start: at(14),
      end: at(14, 30),
      status: 'busy',
      tag,
    },
  ]);
}

// ─── Scenario 3: mixed-modality primary care ────────────────────────────────
//
// Provider-scheduled paradigm, but the same providers can do BOTH
// telehealth and in-person visits. The telehealth service has
// requiresRoom=false, the office visit has requiresRoom=true (needs an
// exam room) — same substrate, `requiresRoom` axis switched. Exercises
// the roomless-row branch of the matrix builder alongside the
// room-requiring one, in the same scenario, without any code path
// specific to "modality."
//
// The engineered story lands at 11:00: all exam rooms are occupied, so
// office visits are infeasible — but a video visit with the remaining
// free provider still books. "Rooms constrain in-person; telehealth
// only needs the provider" comes out of the primitives on its own.

export interface MixedModalitySeedOptions {
  date?: string;
  tag?: string;
}

export async function seedMixedModalityScenario(
  db: Database,
  options: MixedModalitySeedOptions = {},
): Promise<void> {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const at = (h: number, m = 0): string =>
    `${date}T${pad(h)}:${pad(m)}:00.000Z`;
  const { tag } = options;

  if (tag) {
    await db.delete(slots).where(eq(slots.tag, tag));
    await db.delete(providerQualifications).where(eq(providerQualifications.tag, tag));
    await db.delete(providerSchedules).where(eq(providerSchedules.tag, tag));
    await db.delete(locationSchedules).where(eq(locationSchedules.tag, tag));
    await db.delete(servicesRoomRequirements).where(eq(servicesRoomRequirements.tag, tag));
    await db.delete(rooms).where(eq(rooms.tag, tag));
    await db.delete(services).where(eq(services.tag, tag));
    await db.delete(providers).where(eq(providers.tag, tag));
    await db.delete(locations).where(eq(locations.tag, tag));
  }

  const location = makeId('neighborhood', tag);
  const hibbert = makeId('hibbert', tag);
  const crusher = makeId('crusher', tag);
  const cox = makeId('cox', tag);
  const video = makeId('video', tag);
  const office = makeId('office', tag);
  const roomA = makeId('exam-a', tag);
  const roomB = makeId('exam-b', tag);

  await db.insert(locations).values({
    id: location,
    name: 'Neighborhood Health',
    tag,
  });

  await db.insert(providers).values([
    { id: hibbert, name: 'Dr. Julius Hibbert', tag },
    { id: crusher, name: 'Dr. Beverly Crusher', tag },
    { id: cox, name: 'Dr. Perry Cox', tag },
  ]);

  await db.insert(services).values([
    {
      id: video,
      name: 'Video visit',
      durationMinutes: 20,
      requiresProvider: true,
      requiresRoom: false,
      tag,
    },
    {
      id: office,
      name: 'Office visit',
      durationMinutes: 30,
      requiresProvider: true,
      requiresRoom: true,
      tag,
    },
  ]);

  // Every provider can do both modalities — the split isn't "who does
  // what" but "what does the service need."
  await db.insert(providerQualifications).values([
    { providerId: hibbert, serviceId: video, tag },
    { providerId: hibbert, serviceId: office, tag },
    { providerId: crusher, serviceId: video, tag },
    { providerId: crusher, serviceId: office, tag },
    { providerId: cox, serviceId: video, tag },
    { providerId: cox, serviceId: office, tag },
  ]);

  await db.insert(providerSchedules).values([
    { id: makeId('sched-hibbert', tag), providerId: hibbert, locationId: location, start: at(8), end: at(17), tag },
    { id: makeId('sched-crusher', tag), providerId: crusher, locationId: location, start: at(8), end: at(17), tag },
    { id: makeId('sched-cox', tag), providerId: cox, locationId: location, start: at(8), end: at(17), tag },
  ]);

  await db.insert(rooms).values([
    { id: roomA, name: 'Exam Room A', locationId: location, type: 'exam', tag },
    { id: roomB, name: 'Exam Room B', locationId: location, type: 'exam', tag },
  ]);

  // Office visits require an 'exam' room; video visits require nothing
  // (requiresRoom=false on the service takes care of that side).
  await db.insert(servicesRoomRequirements).values([
    { serviceId: office, roomType: 'exam', tag },
  ]);

  // Pins engineered to land the demo story:
  //   9:00 Hibbert · Video    → shows telehealth holds only the provider
  //   9:30 Crusher · Office · A → shows in-person holds provider + a room
  //  10:00 Hibbert · Office · B, 10:30 Cox · Video → morning rhythm
  //  11:00 Hibbert · Office · A, 11:00 Crusher · Office · B
  //    → both exam rooms full. Office at 11:00 is infeasible everywhere
  //      (Cox is free but no room). Video at 11:00 with Cox still
  //      books — the modality that doesn't need a room isn't affected.
  await db.insert(slots).values([
    { id: makeId('pin-hibbert-9-video', tag), providerId: hibbert, locationId: location, serviceId: video, start: at(9), end: at(9, 20), status: 'busy', tag },
    { id: makeId('pin-crusher-930-office', tag), providerId: crusher, locationId: location, serviceId: office, start: at(9, 30), end: at(10), status: 'busy', roomId: roomA, tag },
    { id: makeId('pin-hibbert-10-office', tag), providerId: hibbert, locationId: location, serviceId: office, start: at(10), end: at(10, 30), status: 'busy', roomId: roomB, tag },
    { id: makeId('pin-cox-1030-video', tag), providerId: cox, locationId: location, serviceId: video, start: at(10, 30), end: at(10, 50), status: 'busy', tag },
    { id: makeId('pin-hibbert-11-office', tag), providerId: hibbert, locationId: location, serviceId: office, start: at(11), end: at(11, 30), status: 'busy', roomId: roomA, tag },
    { id: makeId('pin-crusher-11-office', tag), providerId: crusher, locationId: location, serviceId: office, start: at(11), end: at(11, 30), status: 'busy', roomId: roomB, tag },
  ]);
}

// ─── Scenario 4: pure urgent care ────────────────────────────────────────────
//
// Location-scheduled paradigm. One location with two shifts of
// different capacities (5 morning, 3 evening) — capacity now varies
// with staffing over the day. One service (Urgent care visit, 15 min,
// requiresProvider=false, requiresRoom=false). No providers, no rooms.
// A few pinned bookings sprinkled through the day to show capacity
// contention: when a schedule window hits its cap, further bookings in
// that time band become infeasible.

export interface UrgentCareSeedOptions {
  date?: string;
  tag?: string;
}

export async function seedUrgentCareScenario(
  db: Database,
  options: UrgentCareSeedOptions = {},
): Promise<void> {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const at = (h: number, m = 0): string =>
    `${date}T${pad(h)}:${pad(m)}:00.000Z`;
  const { tag } = options;

  // Wipe tag-scoped rows in reverse-FK order.
  if (tag) {
    await db.delete(slots).where(eq(slots.tag, tag));
    await db.delete(providerQualifications).where(eq(providerQualifications.tag, tag));
    await db.delete(providerSchedules).where(eq(providerSchedules.tag, tag));
    await db.delete(locationSchedules).where(eq(locationSchedules.tag, tag));
    await db.delete(servicesRoomRequirements).where(eq(servicesRoomRequirements.tag, tag));
    await db.delete(rooms).where(eq(rooms.tag, tag));
    await db.delete(services).where(eq(services.tag, tag));
    await db.delete(providers).where(eq(providers.tag, tag));
    await db.delete(locations).where(eq(locations.tag, tag));
  }

  const locationId = makeId('downtown-urgent-care', tag);
  await db.insert(locations).values({
    id: locationId,
    name: 'Downtown Urgent Care',
    tag,
  });

  // Two shifts, different capacities. Morning is fully staffed (cap 5),
  // evening is thinner (cap 3). Same location, capacity varies over
  // the day.
  await db.insert(locationSchedules).values([
    {
      id: makeId('sched-downtown-am', tag),
      locationId,
      start: at(8),
      end: at(14),
      capacity: 5,
      tag,
    },
    {
      id: makeId('sched-downtown-pm', tag),
      locationId,
      start: at(14),
      end: at(20),
      capacity: 3,
      tag,
    },
  ]);

  const serviceId = makeId('urgent-visit', tag);
  await db.insert(services).values({
    id: serviceId,
    name: 'Urgent care visit',
    durationMinutes: 15,
    // Cadence < duration models a practice that accepts more bookings
    // per hour than would fit end-to-end. 10-min cadence + 15-min
    // duration = 6 starts per hour with peak concurrency of 2 (each
    // 5-min stretch overlaps its neighbor). "1.5 avg concurrent
    // patients" falls out as an emergent average; the picker just
    // enforces the hard capacity and the cadence.
    bookingCadenceMinutes: 10,
    requiresProvider: false,
    requiresRoom: false,
    tag,
  });

  // Six pinned bookings across the day. Two clusters engineered to be
  // interesting:
  //   - 10:00–10:15 four bookings → 1 slot of capacity left. A fifth
  //     booking succeeds; a sixth is infeasible.
  //   - 14:00–14:15 five bookings → capacity full. Any 14:00 booking is
  //     infeasible until 14:15.
  //   - A handful of morning walk-ins scattered elsewhere.
  const pins = [
    { hour: 8, min: 30, id: 'pin-01' },
    { hour: 9, min: 15, id: 'pin-02' },
    { hour: 10, min: 0, id: 'pin-03' },
    { hour: 10, min: 0, id: 'pin-04' },
    { hour: 10, min: 0, id: 'pin-05' },
    { hour: 10, min: 0, id: 'pin-06' },
    { hour: 14, min: 0, id: 'pin-07' },
    { hour: 14, min: 0, id: 'pin-08' },
    { hour: 14, min: 0, id: 'pin-09' },
    { hour: 14, min: 0, id: 'pin-10' },
    { hour: 14, min: 0, id: 'pin-11' },
  ];
  await db.insert(slots).values(
    pins.map((p) => ({
      id: makeId(p.id, tag),
      // Location-scheduled bookings persist with provider_id = NULL.
      providerId: null,
      locationId,
      serviceId,
      start: at(p.hour, p.min),
      end: at(p.hour, p.min + 15),
      status: 'busy',
      tag,
    })),
  );
}

// ─── Scenario 5: mixed urgent + specialty sharing rooms ─────────────────────
//
// The compelling substrate-story demo. Same location runs urgent care
// AND specialty care. Rooms are shared across the two paradigms:
//
//   Rooms
//     - 2 rooms of type 'urgent-care' (urgent care only)
//     - 3 rooms of type 'exam'        (shared: urgent care can use these
//       too, specialty consult also uses them)
//     - 1 room of type 'imaging'      (specialty imaging only)
//
//   Services
//     - Urgent care visit  — 15 min, requiresProvider=false,
//                             requiresRoom=true, eligibleTypes=['urgent-care', 'exam']
//     - Specialty consult  — 45 min, requiresProvider=true,
//                             requiresRoom=true, eligibleTypes=['exam']
//     - Imaging            — 60 min, requiresProvider=true,
//                             requiresRoom=true, eligibleTypes=['imaging']
//
//   Providers (specialty only; urgent care is provider-less)
//     - Dr. Michaela Quinn (consult + imaging), 9–5
//     - Dr. Nick Riviera   (consult),           9–5
//
// Location nominal capacity is high (8), so the constraint that actually
// bites for urgent care is room availability, not the count. When
// specialty holds exam rooms, urgent care's effective capacity drops.
// That's the story to demo: rooms link the two paradigms.

export interface MixedScenarioSeedOptions {
  date?: string;
  tag?: string;
}

export async function seedMixedScenario(
  db: Database,
  options: MixedScenarioSeedOptions = {},
): Promise<void> {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const at = (h: number, m = 0): string =>
    `${date}T${pad(h)}:${pad(m)}:00.000Z`;
  const { tag } = options;

  if (tag) {
    await db.delete(slots).where(eq(slots.tag, tag));
    await db.delete(providerQualifications).where(eq(providerQualifications.tag, tag));
    await db.delete(providerSchedules).where(eq(providerSchedules.tag, tag));
    await db.delete(locationSchedules).where(eq(locationSchedules.tag, tag));
    await db.delete(servicesRoomRequirements).where(eq(servicesRoomRequirements.tag, tag));
    await db.delete(rooms).where(eq(rooms.tag, tag));
    await db.delete(services).where(eq(services.tag, tag));
    await db.delete(providers).where(eq(providers.tag, tag));
    await db.delete(locations).where(eq(locations.tag, tag));
  }

  const locationId = makeId('community-health-center', tag);
  await db.insert(locations).values({
    id: locationId,
    name: 'Community Health Center',
    tag,
  });

  await db.insert(locationSchedules).values({
    id: makeId('sched-chc', tag),
    locationId,
    start: at(8),
    end: at(20),
    // Cap comfortably above the room count so the binding constraint
    // for urgent care in practice is which rooms are free, not the
    // number.
    capacity: 8,
    tag,
  });

  // Providers — specialty side only.
  await db.insert(providers).values([
    { id: makeId('quinn', tag), name: 'Dr. Michaela Quinn', tag },
    { id: makeId('nick', tag), name: 'Dr. Nick Riviera', tag },
  ]);

  await db.insert(providerSchedules).values([
    {
      id: makeId('sched-quinn', tag),
      providerId: makeId('quinn', tag),
      locationId,
      start: at(9),
      end: at(17),
      tag,
    },
    {
      id: makeId('sched-nick', tag),
      providerId: makeId('nick', tag),
      locationId,
      start: at(9),
      end: at(17),
      tag,
    },
  ]);

  // Services — location-based urgent care + provider-based specialty.
  const urgentServiceId = makeId('urgent-visit', tag);
  const consultServiceId = makeId('consult', tag);
  const imagingServiceId = makeId('imaging', tag);
  await db.insert(services).values([
    {
      id: urgentServiceId,
      name: 'Urgent care visit',
      durationMinutes: 15,
      requiresProvider: false,
      requiresRoom: true,
      tag,
    },
    {
      id: consultServiceId,
      name: 'Specialty consult',
      durationMinutes: 45,
      requiresProvider: true,
      requiresRoom: true,
      tag,
    },
    {
      id: imagingServiceId,
      name: 'Imaging',
      durationMinutes: 60,
      requiresProvider: true,
      requiresRoom: true,
      tag,
    },
  ]);

  await db.insert(providerQualifications).values([
    { providerId: makeId('quinn', tag), serviceId: consultServiceId, tag },
    { providerId: makeId('quinn', tag), serviceId: imagingServiceId, tag },
    { providerId: makeId('nick', tag), serviceId: consultServiceId, tag },
  ]);

  await db.insert(rooms).values([
    // Urgent-care-only rooms.
    { id: makeId('uc1', tag), name: 'UC Room 1', locationId, type: 'urgent-care', tag },
    { id: makeId('uc2', tag), name: 'UC Room 2', locationId, type: 'urgent-care', tag },
    // Shared exam rooms.
    { id: makeId('exam1', tag), name: 'Exam 1', locationId, type: 'exam', tag },
    { id: makeId('exam2', tag), name: 'Exam 2', locationId, type: 'exam', tag },
    { id: makeId('exam3', tag), name: 'Exam 3', locationId, type: 'exam', tag },
    // Imaging.
    { id: makeId('img1', tag), name: 'Imaging Suite', locationId, type: 'imaging', tag },
  ]);

  await db.insert(servicesRoomRequirements).values([
    // Urgent care can use either urgent-care rooms or shared exam rooms.
    { serviceId: urgentServiceId, roomType: 'urgent-care', tag },
    { serviceId: urgentServiceId, roomType: 'exam', tag },
    // Specialty consult uses shared exam rooms only.
    { serviceId: consultServiceId, roomType: 'exam', tag },
    // Imaging uses the imaging suite.
    { serviceId: imagingServiceId, roomType: 'imaging', tag },
  ]);

  // Pinned bookings engineered to expose the contention story:
  //   10:00–10:45 Quinn/consult in Exam 1
  //   10:00–10:45 Nick/consult  in Exam 2
  //   10:15–10:30 urgent walk-in in UC Room 1
  //   10:15–10:30 urgent walk-in in UC Room 2
  //   10:15–10:30 urgent walk-in in Exam 3
  // At 10:15–10:30 all urgent-eligible rooms (2 UC + Exam 3) are taken;
  // Exam 1 and 2 are held by specialty. A new urgent care request for
  // 10:15 should be infeasible — capacity says fine, but no eligible
  // room is free. That's the shared-room contention story.
  //
  //   14:00–15:00 Quinn/imaging in Imaging Suite (unrelated axis,
  //   just decoration).
  await db.insert(slots).values([
    {
      id: makeId('pin-consult-quinn-10', tag),
      providerId: makeId('quinn', tag),
      locationId,
      serviceId: consultServiceId,
      roomId: makeId('exam1', tag),
      start: at(10),
      end: at(10, 45),
      status: 'busy',
      tag,
    },
    {
      id: makeId('pin-consult-nick-10', tag),
      providerId: makeId('nick', tag),
      locationId,
      serviceId: consultServiceId,
      roomId: makeId('exam2', tag),
      start: at(10),
      end: at(10, 45),
      status: 'busy',
      tag,
    },
    {
      id: makeId('pin-uc-uc1-1015', tag),
      providerId: null,
      locationId,
      serviceId: urgentServiceId,
      roomId: makeId('uc1', tag),
      start: at(10, 15),
      end: at(10, 30),
      status: 'busy',
      tag,
    },
    {
      id: makeId('pin-uc-uc2-1015', tag),
      providerId: null,
      locationId,
      serviceId: urgentServiceId,
      roomId: makeId('uc2', tag),
      start: at(10, 15),
      end: at(10, 30),
      status: 'busy',
      tag,
    },
    {
      id: makeId('pin-uc-exam3-1015', tag),
      providerId: null,
      locationId,
      serviceId: urgentServiceId,
      roomId: makeId('exam3', tag),
      start: at(10, 15),
      end: at(10, 30),
      status: 'busy',
      tag,
    },
    {
      id: makeId('pin-imaging-quinn-14', tag),
      providerId: makeId('quinn', tag),
      locationId,
      serviceId: imagingServiceId,
      roomId: makeId('img1', tag),
      start: at(14),
      end: at(15),
      status: 'busy',
      tag,
    },
  ]);
}

// ─── Restore: exported agentic fixture → DB ─────────────────────────────────
//
// Takes one parsed fixture (produced by the Export button on the setups
// list) and inserts every row into its corresponding table with
// onConflictDoNothing. Idempotent — re-running against the same DB
// leaves it unchanged. Used by the deploy's build-time seed to preload
// the reference DB with demo transcripts + committed scenarios.
//
// Insert order respects foreign-key dependencies so the fixture doesn't
// choke if we happen to hit a fresh DB (leaf tables → dependents).
// agenticSetups is independent of the scheduling tables and could go
// anywhere; kept last for symmetry with the export shape.

export interface AgenticFixture {
  exportedAt?: string;
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

// ISO strings in the fixture → Date objects that Drizzle's timestamp
// column type expects. `null` and already-Date values pass through.
function reviveTimestamp(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  throw new Error(`Cannot revive timestamp from ${typeof v}`);
}

export async function restoreAgenticFixture(
  db: Database,
  fixture: AgenticFixture,
): Promise<void> {
  if (fixture.locations.length > 0) {
    await db
      .insert(locations)
      .values(fixture.locations as (typeof locations.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.services.length > 0) {
    await db
      .insert(services)
      .values(fixture.services as (typeof services.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.providers.length > 0) {
    await db
      .insert(providers)
      .values(fixture.providers as (typeof providers.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.rooms.length > 0) {
    await db
      .insert(rooms)
      .values(fixture.rooms as (typeof rooms.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.locationSchedules.length > 0) {
    await db
      .insert(locationSchedules)
      .values(fixture.locationSchedules as (typeof locationSchedules.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.providerQualifications.length > 0) {
    await db
      .insert(providerQualifications)
      .values(fixture.providerQualifications as (typeof providerQualifications.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.providerSchedules.length > 0) {
    await db
      .insert(providerSchedules)
      .values(fixture.providerSchedules as (typeof providerSchedules.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.servicesRoomRequirements.length > 0) {
    await db
      .insert(servicesRoomRequirements)
      .values(fixture.servicesRoomRequirements as (typeof servicesRoomRequirements.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.slots.length > 0) {
    await db
      .insert(slots)
      .values(fixture.slots as (typeof slots.$inferInsert)[])
      .onConflictDoNothing();
  }
  if (fixture.agenticSetups.length > 0) {
    // agentic_setups has timestamp columns; the fixture stores them as
    // ISO strings. Revive to Date before insert so Drizzle serializes
    // through its timestamp path rather than treating them as text.
    const rows = (fixture.agenticSetups as Record<string, unknown>[]).map((r) => ({
      ...r,
      createdAt: reviveTimestamp(r.createdAt),
      committedAt: reviveTimestamp(r.committedAt),
    })) as (typeof agenticSetups.$inferInsert)[];
    await db.insert(agenticSetups).values(rows).onConflictDoNothing();
  }
}
