import { describe, expect, it } from 'vitest';
import {
  proposeReshuffle,
  type ProposeReshuffleContext,
} from '../src/scheduling/proposeReshuffle.js';
import type {
  BookingRequest,
  Instant,
  LocationId,
  ProviderId,
  ProviderScheduleId,
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

const CHECKUP: Service = {
  id: svcId('checkup'),
  name: 'Checkup',
  durationMinutes: 30,
  requiresProvider: true,
};
const CONSULT: Service = {
  id: svcId('consult'),
  name: 'Consult',
  durationMinutes: 30,
  requiresProvider: true,
};

const ALICE = provId('alice');
const BOB = provId('bob');
const CAROL = provId('carol');
const CLINIC = locId('clinic');

const pin = (
  id: string,
  providerId: ProviderId,
  serviceId: ServiceId,
  start: string,
  end: string,
): Slot => ({
  id: slotId(id),
  providerId,
  locationId: CLINIC,
  serviceId,
  start: inst(start),
  end: inst(end),
  status: 'busy',
});

const request = (
  serviceId: ServiceId,
  windowStart: string,
  windowEnd: string,
): BookingRequest => ({
  serviceId,
  window: { start: inst(windowStart), end: inst(windowEnd) },
});

describe('proposeReshuffle', () => {
  it('returns null when no qualified provider can serve the request', () => {
    const ctx: ProposeReshuffleContext = {
      services: [CONSULT],
      qualifications: [], // nobody qualifies
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
    };
    expect(
      proposeReshuffle(
        request(
          CONSULT.id,
          '2026-05-25T09:00:00.000Z',
          '2026-05-25T09:30:00.000Z',
        ),
        ctx,
      ),
    ).toBeNull();
  });

  it('returns a proposal with empty movedPins when there are no pinned slots', () => {
    const ctx: ProposeReshuffleContext = {
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
    };
    const result = proposeReshuffle(
      request(
        CHECKUP.id,
        '2026-05-25T09:00:00.000Z',
        '2026-05-25T10:00:00.000Z',
      ),
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.movedPins).toEqual([]);
    expect(result!.newAssignment.providerId).toBe(ALICE);
    expect(result!.newAssignment.slot.start).toBe(
      '2026-05-25T09:00:00.000Z',
    );
  });

  it('returns a proposal with empty movedPins when a direct candidate exists', () => {
    // Two qualified providers for consult; Bob is pinned at the contested
    // time but Carol is free, so no reshuffle is needed.
    const ctx: ProposeReshuffleContext = {
      services: [CHECKUP, CONSULT],
      qualifications: [
        { providerId: BOB, serviceId: CHECKUP.id },
        { providerId: BOB, serviceId: CONSULT.id },
        { providerId: CAROL, serviceId: CONSULT.id },
      ],
      schedules: [
        {
          id: schedId('s-bob'),
          providerId: BOB,
          locationId: CLINIC,
          start: inst('2026-05-25T09:00:00.000Z'),
          end: inst('2026-05-25T10:00:00.000Z'),
        },
        {
          id: schedId('s-carol'),
          providerId: CAROL,
          locationId: CLINIC,
          start: inst('2026-05-25T09:00:00.000Z'),
          end: inst('2026-05-25T10:00:00.000Z'),
        },
      ],
      pinnedSlots: [
        pin(
          'apt-1',
          BOB,
          CHECKUP.id,
          '2026-05-25T09:00:00.000Z',
          '2026-05-25T09:30:00.000Z',
        ),
      ],
    };
    const result = proposeReshuffle(
      request(
        CONSULT.id,
        '2026-05-25T09:00:00.000Z',
        '2026-05-25T09:30:00.000Z',
      ),
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.movedPins).toEqual([]);
    expect(result!.newAssignment.providerId).toBe(CAROL);
  });

  it('proposes moving a pin to a different qualified provider to fit the new request', () => {
    // Alice qualifies for checkup only; Bob qualifies for both. Bob is
    // pinned for a checkup at 9:00-9:30. The new request is a consult at
    // 9:00-9:30, and Bob is the only qualified consult provider. To fit
    // it, Bob's checkup pin must move to Alice (who can do checkups).
    const ctx: ProposeReshuffleContext = {
      services: [CHECKUP, CONSULT],
      qualifications: [
        { providerId: ALICE, serviceId: CHECKUP.id },
        { providerId: BOB, serviceId: CHECKUP.id },
        { providerId: BOB, serviceId: CONSULT.id },
      ],
      schedules: [
        {
          id: schedId('s-alice'),
          providerId: ALICE,
          locationId: CLINIC,
          start: inst('2026-05-25T09:00:00.000Z'),
          end: inst('2026-05-25T10:00:00.000Z'),
        },
        {
          id: schedId('s-bob'),
          providerId: BOB,
          locationId: CLINIC,
          start: inst('2026-05-25T09:00:00.000Z'),
          end: inst('2026-05-25T10:00:00.000Z'),
        },
      ],
      pinnedSlots: [
        pin(
          'apt-bob-checkup',
          BOB,
          CHECKUP.id,
          '2026-05-25T09:00:00.000Z',
          '2026-05-25T09:30:00.000Z',
        ),
      ],
    };
    const result = proposeReshuffle(
      request(
        CONSULT.id,
        '2026-05-25T09:00:00.000Z',
        '2026-05-25T09:30:00.000Z',
      ),
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.newAssignment.providerId).toBe(BOB);
    expect(result!.newAssignment.slot.serviceId).toBe(CONSULT.id);
    expect(result!.movedPins).toHaveLength(1);
    expect(result!.movedPins[0]!.slotId).toBe(slotId('apt-bob-checkup'));
    expect(result!.movedPins[0]!.fromProviderId).toBe(BOB);
    expect(result!.movedPins[0]!.toProviderId).toBe(ALICE);
  });

  it('returns null when no feasible cover exists even with reshuffling', () => {
    // Only Alice is qualified for the requested service and only Alice has
    // a schedule at the contested time; the pin already occupies her slot
    // and there is no alternative provider to move it to.
    const ctx: ProposeReshuffleContext = {
      services: [CHECKUP],
      qualifications: [{ providerId: ALICE, serviceId: CHECKUP.id }],
      schedules: [
        {
          id: schedId('s-alice'),
          providerId: ALICE,
          locationId: CLINIC,
          start: inst('2026-05-25T09:00:00.000Z'),
          end: inst('2026-05-25T09:30:00.000Z'),
        },
      ],
      pinnedSlots: [
        pin(
          'apt-alice',
          ALICE,
          CHECKUP.id,
          '2026-05-25T09:00:00.000Z',
          '2026-05-25T09:30:00.000Z',
        ),
      ],
    };
    const result = proposeReshuffle(
      request(
        CHECKUP.id,
        '2026-05-25T09:00:00.000Z',
        '2026-05-25T09:30:00.000Z',
      ),
      ctx,
    );
    expect(result).toBeNull();
  });
});
