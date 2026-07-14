import { describe, expect, it } from 'vitest';
import {
  generateSlots,
  type GenerateSlotsContext,
} from '../src/scheduling/generateSlots.js';
import type {
  BookingRequest,
  Instant,
  LocationId,
  ProviderId,
  ProviderScheduleId,
  Service,
  ServiceId,
} from '../src/model.js';

const inst = (s: string): Instant => s as Instant;
const provId = (s: string): ProviderId => s as ProviderId;
const svcId = (s: string): ServiceId => s as ServiceId;
const locId = (s: string): LocationId => s as LocationId;
const schedId = (s: string): ProviderScheduleId => s as ProviderScheduleId;

const CHECKUP: Service = {
  id: svcId('svc-checkup'),
  name: 'Checkup',
  durationMinutes: 30,
  requiresProvider: true,
};

const ALICE = provId('alice');
const BOB = provId('bob');
const CLINIC = locId('clinic');

const baseContext = (): GenerateSlotsContext => ({
  services: [CHECKUP],
  qualifications: [{ providerId: ALICE, serviceId: CHECKUP.id }],
  schedules: [
    {
      id: schedId('s1'),
      providerId: ALICE,
      locationId: CLINIC,
      start: inst('2026-05-25T09:00:00.000Z'),
      end: inst('2026-05-25T12:00:00.000Z'),
    },
  ],
});

const baseRequest = (): BookingRequest => ({
  serviceId: CHECKUP.id,
  window: {
    start: inst('2026-05-25T00:00:00.000Z'),
    end: inst('2026-05-26T00:00:00.000Z'),
  },
});

describe('generateSlots', () => {
  it('emits grid-aligned candidates across a provider schedule', () => {
    // 9:00 to 12:00 = 180 min, 30-min service, 15-min granularity
    // -> starts at 9:00, 9:15, ..., 11:30 = 11 candidates.
    const candidates = generateSlots(baseRequest(), baseContext());
    expect(candidates).toHaveLength(11);
    expect(candidates[0]!.start).toBe('2026-05-25T09:00:00.000Z');
    expect(candidates[10]!.start).toBe('2026-05-25T11:30:00.000Z');
    expect(candidates[10]!.end).toBe('2026-05-25T12:00:00.000Z');
  });

  it('skips providers without a matching qualification', () => {
    const ctx = baseContext();
    ctx.schedules = [
      {
        id: schedId('s-bob'),
        providerId: BOB,
        locationId: CLINIC,
        start: inst('2026-05-25T09:00:00.000Z'),
        end: inst('2026-05-25T12:00:00.000Z'),
      },
    ];
    expect(generateSlots(baseRequest(), ctx)).toHaveLength(0);
  });

  it('intersects schedule with request window', () => {
    const req = baseRequest();
    req.window = {
      start: inst('2026-05-25T10:00:00.000Z'),
      end: inst('2026-05-25T11:00:00.000Z'),
    };
    // 10:00 to 11:00, 30-min service, 15-min grid
    // -> 10:00, 10:15, 10:30 (10:45+30 = 11:15 doesn't fit).
    expect(generateSlots(req, baseContext())).toHaveLength(3);
  });

  it('returns empty when the requested service is unknown', () => {
    const ctx = baseContext();
    ctx.services = [];
    expect(generateSlots(baseRequest(), ctx)).toHaveLength(0);
  });

  it('honors granularityMinutes on the request', () => {
    // 30-min granularity over 9:00-12:00 with 30-min service
    // -> 9:00, 9:30, 10:00, 10:30, 11:00, 11:30 = 6 candidates.
    const req = { ...baseRequest(), granularityMinutes: 30 };
    const candidates = generateSlots(req, baseContext());
    expect(candidates).toHaveLength(6);
  });

  it('aggregates candidates across multiple providers and schedules', () => {
    const ctx = baseContext();
    ctx.qualifications.push({ providerId: BOB, serviceId: CHECKUP.id });
    ctx.schedules.push({
      id: schedId('s-bob'),
      providerId: BOB,
      locationId: CLINIC,
      start: inst('2026-05-25T09:00:00.000Z'),
      end: inst('2026-05-25T12:00:00.000Z'),
    });
    expect(generateSlots(baseRequest(), ctx)).toHaveLength(22);
  });

  it('snaps slot starts to wall-clock granularity boundaries', () => {
    const ctx = baseContext();
    ctx.schedules = [
      {
        id: schedId('s-odd'),
        providerId: ALICE,
        locationId: CLINIC,
        start: inst('2026-05-25T09:07:00.000Z'),
        end: inst('2026-05-25T10:00:00.000Z'),
      },
    ];
    // Window starts at 09:07 but granularity-aligned next start is 09:15.
    // From 09:15, 30-min service fits up to 09:45 (last start) -> 09:15, 09:30.
    const candidates = generateSlots(baseRequest(), ctx);
    expect(candidates.map((c) => c.start)).toEqual([
      '2026-05-25T09:15:00.000Z',
      '2026-05-25T09:30:00.000Z',
    ]);
  });
});
