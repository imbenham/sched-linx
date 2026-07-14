import { describe, expect, it } from 'vitest';
import {
  pickSlot,
  type PickSlotContext,
} from '../src/scheduling/pickSlot.js';
import type {
  BookingRequest,
  Instant,
  LocationId,
  ProviderId,
  ProviderScheduleId,
  RoomId,
  Service,
  ServiceId,
  Slot,
  SlotId,
} from '../src/model.js';

const inst = (s: string): Instant => s as Instant;
const provId = (s: string): ProviderId => s as ProviderId;
const svcId = (s: string): ServiceId => s as ServiceId;
const locId = (s: string): LocationId => s as LocationId;
const schedId = (s: string): ProviderScheduleId => s as ProviderScheduleId;
const slotId = (s: string): SlotId => s as SlotId;
const roomId = (s: string): RoomId => s as RoomId;

const CHECKUP: Service = {
  id: svcId('checkup'),
  name: 'Checkup',
  durationMinutes: 30,
  requiresProvider: true,
};
const ALICE = provId('alice');
const BOB = provId('bob');
const CLINIC = locId('clinic');

const baseCtx = (): PickSlotContext => ({
  services: [CHECKUP],
  qualifications: [{ providerId: ALICE, serviceId: CHECKUP.id }],
  schedules: [
    {
      id: schedId('s-alice'),
      providerId: ALICE,
      locationId: CLINIC,
      start: inst('2026-05-25T09:00:00.000Z'),
      end: inst('2026-05-25T12:00:00.000Z'),
    },
  ],
  pinnedSlots: [],
});

const baseReq = (): BookingRequest => ({
  serviceId: CHECKUP.id,
  window: {
    start: inst('2026-05-25T00:00:00.000Z'),
    end: inst('2026-05-26T00:00:00.000Z'),
  },
});

const pin = (
  id: string,
  providerId: ProviderId,
  start: string,
  end: string,
): Slot => ({
  id: slotId(id),
  providerId,
  locationId: CLINIC,
  serviceId: CHECKUP.id,
  start: inst(start),
  end: inst(end),
  status: 'busy',
});

describe('pickSlot', () => {
  it('returns null when no provider is qualified for the request', () => {
    const ctx = baseCtx();
    ctx.qualifications = [];
    expect(pickSlot(baseReq(), ctx)).toBeNull();
  });

  it('returns the first candidate when there are no pinned slots', () => {
    const result = pickSlot(baseReq(), baseCtx());
    expect(result).not.toBeNull();
    expect(result!.providerId).toBe(ALICE);
    expect(result!.slot.start).toBe('2026-05-25T09:00:00.000Z');
  });

  it('skips candidates that overlap a pinned slot', () => {
    const ctx = baseCtx();
    ctx.pinnedSlots = [
      pin('p1', ALICE, '2026-05-25T09:00:00.000Z', '2026-05-25T09:30:00.000Z'),
    ];
    // 9:00-9:30 fully conflicts; 9:15-9:45 overlaps [9:15, 9:30);
    // 9:30-10:00 starts exactly when the pin ends → first clear candidate.
    const result = pickSlot(baseReq(), ctx);
    expect(result).not.toBeNull();
    expect(result!.slot.start).toBe('2026-05-25T09:30:00.000Z');
    expect(result!.slot.end).toBe('2026-05-25T10:00:00.000Z');
  });

  it('returns null when every candidate conflicts with a pinned slot', () => {
    const ctx = baseCtx();
    ctx.schedules = [
      {
        id: schedId('s-narrow'),
        providerId: ALICE,
        locationId: CLINIC,
        start: inst('2026-05-25T09:00:00.000Z'),
        end: inst('2026-05-25T10:00:00.000Z'),
      },
    ];
    ctx.pinnedSlots = [
      pin('p1', ALICE, '2026-05-25T09:00:00.000Z', '2026-05-25T10:00:00.000Z'),
    ];
    expect(pickSlot(baseReq(), ctx)).toBeNull();
  });

  it('falls through to a different provider when one is fully blocked', () => {
    const ctx = baseCtx();
    ctx.qualifications.push({ providerId: BOB, serviceId: CHECKUP.id });
    ctx.schedules.push({
      id: schedId('s-bob'),
      providerId: BOB,
      locationId: CLINIC,
      start: inst('2026-05-25T09:00:00.000Z'),
      end: inst('2026-05-25T12:00:00.000Z'),
    });
    // Pin covers Alice's entire schedule; every Alice candidate strands
    // the pin. Bob shares no intervals with the pin, so Bob's first
    // candidate is the answer.
    ctx.pinnedSlots = [
      pin('p1', ALICE, '2026-05-25T09:00:00.000Z', '2026-05-25T12:00:00.000Z'),
    ];
    const result = pickSlot(baseReq(), ctx);
    expect(result).not.toBeNull();
    expect(result!.providerId).toBe(BOB);
    expect(result!.slot.start).toBe('2026-05-25T09:00:00.000Z');
  });
});

// End-to-end room scenarios: the picker takes a context that includes
// rooms and servicesRoomRequirements; generateSlots fans candidates out
// over eligible rooms; buildSchedulingMatrix (default sources, so both
// provider and room intervals) enforces both axes. These tests prove
// that the room constraint participates in real picker decisions, not
// just in axis-isolated matrix tests.
describe('pickSlot with room constraints', () => {
  const IMAGING: Service = {
    id: svcId('imaging'),
    name: 'Imaging',
    durationMinutes: 30,
    requiresProvider: true,
    requiresRoom: true,
  };
  const ROOM1 = roomId('room1');
  const ROOM2 = roomId('room2');

  // Default: Alice qualified for imaging, schedule 9-12, one imaging room.
  const imagingCtx = (): PickSlotContext => ({
    services: [IMAGING],
    qualifications: [{ providerId: ALICE, serviceId: IMAGING.id }],
    schedules: [
      {
        id: schedId('s-alice'),
        providerId: ALICE,
        locationId: CLINIC,
        start: inst('2026-05-25T09:00:00.000Z'),
        end: inst('2026-05-25T12:00:00.000Z'),
      },
    ],
    pinnedSlots: [],
    rooms: [{ id: ROOM1, name: 'Room 1', locationId: CLINIC, type: 'imaging' }],
    servicesRoomRequirements: [{ serviceId: IMAGING.id, roomType: 'imaging' }],
  });

  const imagingReq = (): BookingRequest => ({
    serviceId: IMAGING.id,
    window: {
      start: inst('2026-05-25T09:00:00.000Z'),
      end: inst('2026-05-25T12:00:00.000Z'),
    },
  });

  const roomedPin = (
    id: string,
    providerId: ProviderId,
    pinRoomId: RoomId,
    start: string,
    end: string,
  ): Slot => ({
    id: slotId(id),
    providerId,
    locationId: CLINIC,
    serviceId: IMAGING.id,
    start: inst(start),
    end: inst(end),
    status: 'busy',
    roomId: pinRoomId,
  });

  it('assigns a roomId on the chosen candidate', () => {
    const result = pickSlot(imagingReq(), imagingCtx());
    expect(result).not.toBeNull();
    expect(result!.slot.start).toBe('2026-05-25T09:00:00.000Z');
    expect(result!.slot.roomId).toBe(ROOM1);
  });

  it('skips a candidate when its room is held at that time, then picks the next free time', () => {
    const ctx = imagingCtx();
    ctx.pinnedSlots = [
      roomedPin(
        'pin-9',
        ALICE,
        ROOM1,
        '2026-05-25T09:00:00.000Z',
        '2026-05-25T09:30:00.000Z',
      ),
    ];
    const result = pickSlot(imagingReq(), ctx);
    expect(result).not.toBeNull();
    expect(result!.slot.start).toBe('2026-05-25T09:30:00.000Z');
    expect(result!.slot.roomId).toBe(ROOM1);
  });

  it('routes to a second eligible room when another provider holds the first', () => {
    // Two qualified providers (Alice, Bob), two imaging rooms. Bob holds
    // Room 1 at 9:00 — Alice's 9:00 candidate in Room 1 strands the pin
    // (via the room axis, not the provider axis). The picker should
    // advance to Alice's 9:00 candidate in Room 2.
    const ctx = imagingCtx();
    ctx.qualifications.push({ providerId: BOB, serviceId: IMAGING.id });
    ctx.schedules.push({
      id: schedId('s-bob'),
      providerId: BOB,
      locationId: CLINIC,
      start: inst('2026-05-25T09:00:00.000Z'),
      end: inst('2026-05-25T12:00:00.000Z'),
    });
    ctx.rooms = [
      { id: ROOM1, name: 'Room 1', locationId: CLINIC, type: 'imaging' },
      { id: ROOM2, name: 'Room 2', locationId: CLINIC, type: 'imaging' },
    ];
    ctx.pinnedSlots = [
      roomedPin(
        'pin-bob',
        BOB,
        ROOM1,
        '2026-05-25T09:00:00.000Z',
        '2026-05-25T09:30:00.000Z',
      ),
    ];
    const result = pickSlot(imagingReq(), ctx);
    expect(result).not.toBeNull();
    expect(result!.providerId).toBe(ALICE);
    expect(result!.slot.start).toBe('2026-05-25T09:00:00.000Z');
    expect(result!.slot.roomId).toBe(ROOM2);
  });

  it('returns null when the only eligible room is fully blocked', () => {
    const ctx = imagingCtx();
    // Pin covers Alice in Room 1 for the entire schedule. Alice is the
    // only qualified provider; Room 1 is the only imaging room. Every
    // candidate conflicts with the pin on both axes — no path forward.
    ctx.pinnedSlots = [
      roomedPin(
        'pin-day',
        ALICE,
        ROOM1,
        '2026-05-25T09:00:00.000Z',
        '2026-05-25T12:00:00.000Z',
      ),
    ];
    expect(pickSlot(imagingReq(), ctx)).toBeNull();
  });

  it('returns null when no rooms exist for a service that requires one', () => {
    // Same setup as imagingCtx but with an empty rooms array. generateSlots
    // should reject upstream (no eligible rooms → no candidates), which
    // surfaces here as picker returning null.
    const ctx = imagingCtx();
    ctx.rooms = [];
    expect(pickSlot(imagingReq(), ctx)).toBeNull();
  });
});

// Multi-location location-scheduled routing — the "telehealth wrinkle"
// from the transcript in miniature. Three locations offer the same
// location-scheduled service (`urgent`, requiresProvider=false). When
// the caller omits BookingRequest.locationId, the picker collects all
// feasible (location, window) options at the earliest window and picks
// the one with the most remaining headroom; insertion order breaks
// ties. When the caller sets locationId, it acts as a hard pre-filter.
describe('pickSlot — multi-location location-scheduled routing', () => {
  const URGENT: Service = {
    id: svcId('urgent'),
    name: 'Urgent care visit',
    durationMinutes: 15,
    requiresProvider: false,
    requiresRoom: false,
  };

  const DOWNTOWN = locId('downtown');
  const RIVERSIDE = locId('riverside');
  const NORTHSIDE = locId('northside');

  const shiftId = (s: string) => s as unknown as import('../src/model.js').LocationScheduleId;

  // Same schedule window (10:00–12:00) for all three; distinct capacities
  // let the routing story stand out.
  const scheduleFor = (id: string, locationId: LocationId, capacity: number) => ({
    id: shiftId(id),
    locationId,
    start: inst('2026-05-25T10:00:00.000Z'),
    end: inst('2026-05-25T12:00:00.000Z'),
    capacity,
  });

  const baseCtx = (): PickSlotContext => ({
    services: [URGENT],
    qualifications: [],
    schedules: [],
    pinnedSlots: [],
    locations: [
      { id: DOWNTOWN, name: 'Downtown' },
      { id: RIVERSIDE, name: 'Riverside' },
      { id: NORTHSIDE, name: 'Northside' },
    ],
    locationSchedules: [
      scheduleFor('sched-downtown', DOWNTOWN, 5),
      scheduleFor('sched-riverside', RIVERSIDE, 5),
      scheduleFor('sched-northside', NORTHSIDE, 5),
    ],
  });

  const urgentReq = (extra: Partial<BookingRequest> = {}): BookingRequest => ({
    serviceId: URGENT.id,
    window: {
      start: inst('2026-05-25T10:00:00.000Z'),
      end: inst('2026-05-25T11:00:00.000Z'),
    },
    ...extra,
  });

  const locPin = (
    id: string,
    loc: LocationId,
    start: string,
    end: string,
  ): Slot => ({
    id: slotId(id),
    providerId: undefined,
    locationId: loc,
    serviceId: URGENT.id,
    start: inst(start),
    end: inst(end),
    status: 'busy',
  });

  it('routes to the location with the most remaining headroom', () => {
    const ctx = baseCtx();
    // At the earliest window (10:00–10:15), Downtown has 4 of 5 taken
    // (headroom 1), Riverside has 1 of 5 taken (headroom 4), Northside
    // has 3 of 5 taken (headroom 2). Riverside should win.
    ctx.pinnedSlots = [
      locPin('d1', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('d2', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('d3', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('d4', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('r1', RIVERSIDE, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('n1', NORTHSIDE, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('n2', NORTHSIDE, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('n3', NORTHSIDE, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
    ];
    const result = pickSlot(urgentReq(), ctx);
    expect(result).not.toBeNull();
    expect(result!.slot.locationId).toBe(RIVERSIDE);
    expect(result!.slot.start).toBe('2026-05-25T10:00:00.000Z');
    expect(result!.providerId).toBeUndefined();
  });

  it('breaks ties by insertion order', () => {
    const ctx = baseCtx();
    // All three locations equally loaded → Downtown (first in the
    // locations array) wins the tiebreak.
    ctx.pinnedSlots = [
      locPin('d1', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('r1', RIVERSIDE, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('n1', NORTHSIDE, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
    ];
    const result = pickSlot(urgentReq(), ctx);
    expect(result).not.toBeNull();
    expect(result!.slot.locationId).toBe(DOWNTOWN);
  });

  it('respects request.locationId as a hard pre-filter', () => {
    const ctx = baseCtx();
    // Downtown is congested, Riverside is free — but the caller
    // explicitly asked for Downtown, so we get Downtown (still with
    // one seat available at 10:00) not Riverside.
    ctx.pinnedSlots = [
      locPin('d1', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('d2', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('d3', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
      locPin('d4', DOWNTOWN, '2026-05-25T10:00:00.000Z', '2026-05-25T10:15:00.000Z'),
    ];
    const result = pickSlot(urgentReq({ locationId: DOWNTOWN }), ctx);
    expect(result).not.toBeNull();
    expect(result!.slot.locationId).toBe(DOWNTOWN);
  });

  it('returns null when the requested location has no capacity even if another does', () => {
    const ctx = baseCtx();
    // Downtown is full at every 15-min window in the request span.
    // Riverside is wide open, but the caller wants Downtown → null.
    const stackedAtDowntown = Array.from({ length: 5 }, (_, i) =>
      locPin(
        `d${i}`,
        DOWNTOWN,
        '2026-05-25T10:00:00.000Z',
        '2026-05-25T11:00:00.000Z',
      ),
    );
    ctx.pinnedSlots = stackedAtDowntown;
    const result = pickSlot(urgentReq({ locationId: DOWNTOWN }), ctx);
    expect(result).toBeNull();
  });

  it('finds the earliest feasible window across locations', () => {
    const ctx = baseCtx();
    // Downtown is full at 10:00–10:15 and 10:15–10:30. Riverside is
    // completely free. Earliest feasible window is 10:00 at Riverside.
    ctx.pinnedSlots = Array.from({ length: 5 }, (_, i) =>
      locPin(
        `d${i}`,
        DOWNTOWN,
        '2026-05-25T10:00:00.000Z',
        '2026-05-25T10:30:00.000Z',
      ),
    );
    const result = pickSlot(urgentReq(), ctx);
    expect(result).not.toBeNull();
    expect(result!.slot.start).toBe('2026-05-25T10:00:00.000Z');
    expect(result!.slot.locationId).toBe(RIVERSIDE);
  });
});
