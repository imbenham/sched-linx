import { describe, expect, it } from 'vitest';
import { search } from '../src/dlx.js';
import { buildSchedulingMatrix, providerIntervalSource, roomIntervalSource } from '../src/scheduling/buildSchedulingMatrix.js';
import type {
  Instant,
  LocationId,
  ProviderId,
  RoomId,
  ServiceId,
  SlotCandidate,
} from '../src/model.js';

const provId = (s: string) => s as ProviderId;
const svcId = (s: string) => s as ServiceId;
const locId = (s: string) => s as LocationId;
const inst = (s: string) => s as Instant;
const roomId = (s: string) => s as RoomId;

const ALICE = provId('alice');
const BOB = provId('bob');
const CLINIC = locId('clinic');
const CHECKUP = svcId('checkup');

const roomIds = [roomId('room1'), roomId('room2'), roomId('room3')];

interface CreateSlotParams {
  providerId: ProviderId;
  start: string;
  end: string;
  locationId?: LocationId;
  serviceId?: ServiceId;
  roomId?: RoomId;
}

const slot = (
  params: CreateSlotParams
): SlotCandidate => {
  const {
    providerId,
    start,
    end,
    locationId = CLINIC,
    serviceId = CHECKUP,
    roomId,
  } = params;
  return {
    providerId,
    locationId,
    serviceId,
    start: inst(start),
    end: inst(end),
    roomId,
  };
};

describe('buildSchedulingMatrix', () => {
  it('finds a cover for a single booking with a single candidate', () => {
    const result = buildSchedulingMatrix({
      bookings: [
        {
          bookingId: 'b1',
          candidates: [
            slot({
              providerId: ALICE,
              start: '2026-05-25T09:00:00.000Z',
              end: '2026-05-25T09:30:00.000Z',
            }),
          ],
        },
      ],
    });
    const solutions = search(result.matrix);
    expect(solutions).toHaveLength(1);
    expect(solutions[0]).toHaveLength(1);
    const resolved = result.resolveRow(solutions[0]![0]!);
    expect(resolved?.bookingId).toBe('b1');
    expect(resolved?.slot.start).toBe('2026-05-25T09:00:00.000Z');
  });

  it('returns no cover when a booking has no candidates', () => {
    const result = buildSchedulingMatrix({
      bookings: [{ bookingId: 'b1', candidates: [] }],
    });
    expect(search(result.matrix)).toHaveLength(0);
  });

  it('assigns bookings across different providers independently', () => {
    const result = buildSchedulingMatrix({
      bookings: [
        {
          bookingId: 'a',
          candidates: [
            slot({
              providerId: ALICE,
              start: '2026-05-25T09:00:00.000Z',
              end: '2026-05-25T09:30:00.000Z',
            }),
          ],
        },
        {
          bookingId: 'b',
          candidates: [
            slot({
              providerId: BOB,
              start: '2026-05-25T09:00:00.000Z',
              end: '2026-05-25T09:30:00.000Z',
            }),
          ],
        },
      ],
    });
    const solutions = search(result.matrix);
    expect(solutions).toHaveLength(1);
    expect(solutions[0]).toHaveLength(2);
    const bookingIds = solutions[0]!
      .map((id) => result.resolveRow(id)!.bookingId)
      .sort();
    expect(bookingIds).toEqual(['a', 'b']);
  });

  it('returns no cover when two same-provider bookings can only use the same slot', () => {
    const sameSlot = slot({
      providerId: ALICE,
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T09:30:00.000Z',
    });
    const result = buildSchedulingMatrix({
      bookings: [
        { bookingId: 'a', candidates: [sameSlot] },
        { bookingId: 'b', candidates: [sameSlot] },
      ],
    });
    expect(search(result.matrix)).toHaveLength(0);
  });

  it('forces the open booking away from candidates that conflict with a pinned slot', () => {
    const result = buildSchedulingMatrix({
      bookings: [
        // Pinned: single candidate, must be included.
        {
          bookingId: 'pinned',
          candidates: [
            slot({
              providerId: ALICE,
              start: '2026-05-25T09:30:00.000Z',
              end: '2026-05-25T09:45:00.000Z',
            }),
          ],
        },
        // Open: three candidates; only the first avoids the pinned window.
        {
          bookingId: 'open',
          candidates: [
            slot({
              providerId: ALICE,
              start: '2026-05-25T09:00:00.000Z',
              end: '2026-05-25T09:30:00.000Z',
            }),
            slot({
              providerId: ALICE,
              start: '2026-05-25T09:15:00.000Z',
              end: '2026-05-25T09:45:00.000Z',
            }),
            slot({
              providerId: ALICE,
              start: '2026-05-25T09:30:00.000Z',
              end: '2026-05-25T10:00:00.000Z',
            }),
          ],
        },
      ],
    });
    const solutions = search(result.matrix);
    expect(solutions).toHaveLength(1);
    const resolved = solutions[0]!.map((id) => result.resolveRow(id)!);
    const open = resolved.find((r) => r.bookingId === 'open')!;
    expect(open.slot.start).toBe('2026-05-25T09:00:00.000Z');
    expect(open.slot.end).toBe('2026-05-25T09:30:00.000Z');
  });

  it('enumerates both feasible covers when two same-provider bookings could swap slots', () => {
    const morning = slot({
      providerId: ALICE,
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T09:30:00.000Z',
    });
    const noon = slot({
      providerId: ALICE,
      start: '2026-05-25T09:30:00.000Z',
      end: '2026-05-25T10:00:00.000Z',
    });
    const result = buildSchedulingMatrix({
      bookings: [
        { bookingId: 'a', candidates: [morning, noon] },
        { bookingId: 'b', candidates: [morning, noon] },
      ],
    });
    const solutions = search(result.matrix, { onSolution: () => false });
    // Feasible: {a=morning, b=noon} and {a=noon, b=morning}.
    expect(solutions).toHaveLength(2);
    for (const sol of solutions) {
      expect(sol).toHaveLength(2);
      const startTimes = sol.map((id) => result.resolveRow(id)!.slot.start);
      expect(new Set(startTimes).size).toBe(2);
    }
  });

  it('replicates the HANDOFF event-interval example', () => {
    // The four overlapping candidates from HANDOFF.md, used as the
    // candidate set for two bookings. Per the doc's compatibility table,
    // the non-overlapping pairs (ignoring which booking gets which) are
    // {SA, SC} and {SA, SD}. With distinct bookings, each pair yields 2
    // ordered assignments, for 4 total solutions.
    const SA = slot({
      providerId: ALICE,
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T09:15:00.000Z',
    });
    const SB = slot({
      providerId: ALICE,
      start: '2026-05-25T09:00:00.000Z',
      end: '2026-05-25T09:30:00.000Z',
    });
    const SC = slot({
      providerId: ALICE,
      start: '2026-05-25T09:15:00.000Z',
      end: '2026-05-25T09:30:00.000Z',
    });
    const SD = slot({
      providerId: ALICE,
      start: '2026-05-25T09:15:00.000Z',
      end: '2026-05-25T10:00:00.000Z',
    });
    const result = buildSchedulingMatrix({
      bookings: [
        { bookingId: 'b1', candidates: [SA, SB, SC, SD] },
        { bookingId: 'b2', candidates: [SA, SB, SC, SD] },
      ],
    });
    const solutions = search(result.matrix, { onSolution: () => false });
    expect(solutions).toHaveLength(4);
    for (const sol of solutions) {
      const slots = sol
        .map((id) => result.resolveRow(id)!.slot)
        .sort((a, b) => a.start.localeCompare(b.start));
      // Each solution's two slots must not overlap (sorted by start,
      // earlier end must be at or before later start).
      expect(slots[0]!.end <= slots[1]!.start).toBe(true);
    }
  });
  it('finds a cover for a single booking with a single roomed candidate', () => {
    const result = buildSchedulingMatrix(
      {
        bookings: [
          {
            bookingId: 'b1',
            candidates: [
              slot({
                providerId: ALICE,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
                roomId: roomIds[0],
              }),
            ],
          },
        ],
      },
      [providerIntervalSource, roomIntervalSource],
    );
    const solutions = search(result.matrix);
    expect(solutions).toHaveLength(1);
    expect(solutions[0]).toHaveLength(1);
    const resolved = result.resolveRow(solutions[0]![0]!);
    expect(resolved?.bookingId).toBe('b1');
    expect(resolved?.slot.start).toBe('2026-05-25T09:00:00.000Z');
    expect(resolved?.slot.roomId).toBe(roomIds[0]);
  });
});

// roomIntervalSource is tested in isolation here — only the room axis is
// active in RESOURCE_SOURCES, so any conflict in these tests must be a
// room-axis conflict. The composed-axes case (provider + room together) is
// covered by the default-sources test at the bottom of this block.
describe('buildSchedulingMatrix with [roomIntervalSource] only', () => {
  it('rejects two same-room candidates whose windows overlap', () => {
    // Different providers, same room, overlapping times. Provider axis
    // would let this pass; room axis must catch it.
    const result = buildSchedulingMatrix(
      {
        bookings: [
          {
            bookingId: 'a',
            candidates: [
              slot({
                providerId: ALICE,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
                roomId: roomIds[0],
              }),
            ],
          },
          {
            bookingId: 'b',
            candidates: [
              slot({
                providerId: BOB,
                start: '2026-05-25T09:15:00.000Z',
                end: '2026-05-25T09:45:00.000Z',
                roomId: roomIds[0],
              }),
            ],
          },
        ],
      },
      [roomIntervalSource],
    );
    expect(search(result.matrix)).toHaveLength(0);
  });

  it('accepts two same-room candidates whose windows touch but do not overlap', () => {
    const result = buildSchedulingMatrix(
      {
        bookings: [
          {
            bookingId: 'a',
            candidates: [
              slot({
                providerId: ALICE,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
                roomId: roomIds[0],
              }),
            ],
          },
          {
            bookingId: 'b',
            candidates: [
              slot({
                providerId: BOB,
                start: '2026-05-25T09:30:00.000Z',
                end: '2026-05-25T10:00:00.000Z',
                roomId: roomIds[0],
              }),
            ],
          },
        ],
      },
      [roomIntervalSource],
    );
    expect(search(result.matrix)).toHaveLength(1);
  });

  it('accepts overlapping candidates that occupy different rooms', () => {
    const result = buildSchedulingMatrix(
      {
        bookings: [
          {
            bookingId: 'a',
            candidates: [
              slot({
                providerId: ALICE,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
                roomId: roomIds[0],
              }),
            ],
          },
          {
            bookingId: 'b',
            candidates: [
              slot({
                providerId: BOB,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
                roomId: roomIds[1],
              }),
            ],
          },
        ],
      },
      [roomIntervalSource],
    );
    expect(search(result.matrix)).toHaveLength(1);
  });

  it('ignores roomless rows entirely (telehealth equivalents pass through)', () => {
    // Two roomless candidates at the same time. With only the room source
    // active, they have no secondary columns at all — the matrix should
    // happily cover both.
    const result = buildSchedulingMatrix(
      {
        bookings: [
          {
            bookingId: 'a',
            candidates: [
              slot({
                providerId: ALICE,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
              }),
            ],
          },
          {
            bookingId: 'b',
            candidates: [
              slot({
                providerId: BOB,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
              }),
            ],
          },
        ],
      },
      [roomIntervalSource],
    );
    expect(search(result.matrix)).toHaveLength(1);
  });

  it('treats a roomless row as conflict-free against a same-time roomed row', () => {
    // A telehealth booking and an in-person booking at the same provider
    // and time. (Practically a provider would conflict in real life, but
    // we're isolating the room axis — provider source isn't active.) The
    // room column for the roomed row exists; the roomless row has no
    // cells in it. Cover succeeds.
    const result = buildSchedulingMatrix(
      {
        bookings: [
          {
            bookingId: 'telehealth',
            candidates: [
              slot({
                providerId: ALICE,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
              }),
            ],
          },
          {
            bookingId: 'in-person',
            candidates: [
              slot({
                providerId: ALICE,
                start: '2026-05-25T09:00:00.000Z',
                end: '2026-05-25T09:30:00.000Z',
                roomId: roomIds[0],
              }),
            ],
          },
        ],
      },
      [roomIntervalSource],
    );
    expect(search(result.matrix)).toHaveLength(1);
  });
});

describe('buildSchedulingMatrix with default sources (provider + room composed)', () => {
  it('catches a room conflict that the provider source alone would miss', () => {
    // Different providers (provider axis: fine) sharing a room with
    // overlapping windows (room axis: conflict). The default RESOURCE_SOURCES
    // includes both, so the matrix correctly rejects.
    const result = buildSchedulingMatrix({
      bookings: [
        {
          bookingId: 'a',
          candidates: [
            slot({
              providerId: ALICE,
              start: '2026-05-25T09:00:00.000Z',
              end: '2026-05-25T09:30:00.000Z',
              roomId: roomIds[0],
            }),
          ],
        },
        {
          bookingId: 'b',
          candidates: [
            slot({
              providerId: BOB,
              start: '2026-05-25T09:15:00.000Z',
              end: '2026-05-25T09:45:00.000Z',
              roomId: roomIds[0],
            }),
          ],
        },
      ],
    });
    expect(search(result.matrix)).toHaveLength(0);
  });
});
