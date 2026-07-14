import { describe, expect, it } from 'vitest';
import { buildMatrix } from '../src/dlx.js';
import { formatMatrix, printMatrix } from '../src/printMatrix.js';
import { buildSchedulingMatrix } from '../src/scheduling/buildSchedulingMatrix.js';
import type {
  Instant,
  LocationId,
  ProviderId,
  ServiceId,
  SlotCandidate,
} from '../src/model.js';

describe('formatMatrix', () => {
  it('renders a simple primary-only matrix', () => {
    const matrix = buildMatrix(
      ['A', 'B'],
      [],
      [
        { rowId: 'r1', columns: ['A'] },
        { rowId: 'r2', columns: ['B'] },
        { rowId: 'r3', columns: ['A', 'B'] },
      ],
    );
    const output = formatMatrix(matrix);
    expect(output).toContain('2 primary, 0 secondary, 3 rows');
    expect(output).toContain('P0 = A');
    expect(output).toContain('P1 = B');
    expect(output).toContain('r1');
    expect(output).toContain('r3');
  });

  it('distinguishes primary and secondary columns', () => {
    const matrix = buildMatrix(
      ['A'],
      ['X'],
      [{ rowId: 'r1', columns: ['A', 'X'] }],
    );
    const output = formatMatrix(matrix);
    expect(output).toContain('1 primary, 1 secondary');
    expect(output).toContain('P0 = A');
    expect(output).toContain('S0 = X');
  });

  it('handles a matrix with no rows', () => {
    const matrix = buildMatrix(['A'], [], []);
    const output = formatMatrix(matrix);
    expect(output).toContain('1 primary, 0 secondary, 0 rows');
  });

  it('demos the HANDOFF event-interval example (prints to console)', () => {
    // One booking with the four candidates from HANDOFF.md's worked example
    // for Alice. The matrix shape lines up exactly with the table there:
    //   SA = 9:00-9:15 covers I1
    //   SB = 9:00-9:30 covers I1, I2
    //   SC = 9:15-9:30 covers I2
    //   SD = 9:15-10:00 covers I2, I3
    const ALICE = 'alice' as ProviderId;
    const CLINIC = 'clinic' as LocationId;
    const CHECKUP = 'checkup' as ServiceId;
    const mk = (start: string, end: string): SlotCandidate => ({
      providerId: ALICE,
      locationId: CLINIC,
      serviceId: CHECKUP,
      start: start as Instant,
      end: end as Instant,
    });
    const result = buildSchedulingMatrix({
      bookings: [
        {
          bookingId: 'b1',
          candidates: [
            mk('2026-05-25T09:00:00.000Z', '2026-05-25T09:15:00.000Z'),
            mk('2026-05-25T09:00:00.000Z', '2026-05-25T09:30:00.000Z'),
            mk('2026-05-25T09:15:00.000Z', '2026-05-25T09:30:00.000Z'),
            mk('2026-05-25T09:15:00.000Z', '2026-05-25T10:00:00.000Z'),
          ],
        },
      ],
    });
    printMatrix(result.matrix);
    expect(formatMatrix(result.matrix)).toContain(
      '1 primary, 3 secondary, 4 rows',
    );
  });
});
