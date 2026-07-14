import { buildMatrix, type Matrix, type RowSpec } from '../dlx';
import type { Instant, ProviderId, SlotCandidate } from '../model';
import { printMatrix } from '../printMatrix';

// A booking corresponds to one primary column (exactly-once: every booking
// gets a slot). Its candidates correspond to one or more rows. Pinned
// bookings (existing Appointments) are represented with a single candidate —
// the slot the appointment already occupies — so DLX has no alternative but
// to include it.
export interface SchedulingBooking {
  bookingId: string;
  candidates: SlotCandidate[];
}

export interface SchedulingMatrixInput {
  bookings: SchedulingBooking[];
}

export interface BuildSchedulingMatrixResult {
  matrix: Matrix;
  /** Map a row id from a DLX solution back to its booking and chosen slot. */
  resolveRow: (
    rowId: string,
  ) => { bookingId: string; slot: SlotCandidate } | undefined;
}

const toEpoch = (i: Instant): number => Date.parse(i);

// Column / row name conventions. These names are opaque keys; nothing
// outside this module should parse them.
const primaryFor = (bookingId: string): string => `booking:${bookingId}`;
const rowFor = (bookingId: string, idx: number): string =>
  `row:${bookingId}:${idx}`;
const makeIntervalKey = (type: 'provider' | 'room', resourceId: string, idx: number): string =>
  `iv:${type}:${resourceId}:${idx}`;

interface PendingRow {
  rowId: string;
  bookingId: string;
  slot: SlotCandidate;
}

interface ResourceContribution {
  columnIds: string[];
  cellsByRow: Map<string, string[]>;
}

// A resource-cell source emits secondary columns and per-row cells for one
// resource axis. v1 has twp sources (provider event-intervals and room event-intervals). Future axes
// plug in additively by appending to RESOURCE_SOURCES - the algorithm and surrounding plumbing don't change.
type ResourceCellSource = (rows: readonly PendingRow[]) => ResourceContribution;

export const providerIntervalSource: ResourceCellSource = (rows) => {
  return getMatrixElementsBySlotProperty('providerId', rows);
};

export const roomIntervalSource: ResourceCellSource = (rows) => {
  return getMatrixElementsBySlotProperty('roomId', rows);
};

const getMatrixElementsBySlotProperty = (property: 'providerId' | 'roomId', rows: readonly PendingRow[]): ResourceContribution => {
  // console.log('providerIntervalSource input rows:', rows);

  const byProp = new Map<string, PendingRow[]>();
  for (const row of rows) {
    // Skip rows that don't have this resource (e.g. roomless candidates
    // from telehealth services have no roomId). Without this guard, the
    // grouping would key on `undefined` and create a phantom interval
    // column that all such rows would compete for, falsely conflicting.
    const value = row.slot[property];
    if (!value) continue;
    const existing = byProp.get(value);
    if (existing) existing.push(row);
    else byProp.set(value, [row]);
  }

  const columnIds: string[] = [];
  const cellsByRow = new Map<string, string[]>();

  for (const [propId, propRows] of byProp) {
    // Distinct event timestamps for this property, sorted ascending.
    const eventSet = new Set<number>();
    for (const r of propRows) {
      eventSet.add(toEpoch(r.slot.start));
      eventSet.add(toEpoch(r.slot.end));
    }
    const events = [...eventSet].sort((a, b) => a - b);

    // Consecutive events form intervals: [events[i], events[i+1]).
    let keyName: 'room' | 'provider';
    if (property === 'providerId') keyName = 'provider';
    else if (property === 'roomId') keyName = 'room';
    else throw new Error(`Unexpected property: ${property}`);
    const intervalStarts: number[] = [];
    const intervalEnds: number[] = [];
    const intervalCols: string[] = [];
    for (let i = 0; i < events.length - 1; i++) {
      intervalStarts.push(events[i]!);
      intervalEnds.push(events[i + 1]!);
      const colId = makeIntervalKey(keyName, propId, i);
      intervalCols.push(colId);
      columnIds.push(colId);
    }

    // Because intervals are formed from slot boundaries, a slot "covers"
    // interval i iff slot.start <= intervalStarts[i] && slot.end >= intervalEnds[i].
    for (const r of propRows) {
      const slotStart = toEpoch(r.slot.start);
      const slotEnd = toEpoch(r.slot.end);
      const cells: string[] = [];
      for (let i = 0; i < intervalCols.length; i++) {
        if (slotStart <= intervalStarts[i]! && slotEnd >= intervalEnds[i]!) {
          cells.push(intervalCols[i]!);
        }
      }
      const prior = cellsByRow.get(r.rowId);
      cellsByRow.set(r.rowId, prior ? [...prior, ...cells] : cells);
    }
  }

  return { columnIds, cellsByRow };
};

// The default constraint set for production callers (pickProvider,
// proposeReshuffle). Tests can pass a custom array to buildSchedulingMatrix's
// second argument to isolate one axis at a time. Adding a future axis
// (equipment, etc.) is purely additive — append a source here; everything
// downstream Just Works.
const RESOURCE_SOURCES: readonly ResourceCellSource[] = [
  providerIntervalSource,
  roomIntervalSource,
];

export function buildSchedulingMatrix(
  input: SchedulingMatrixInput,
  resourceSources: readonly ResourceCellSource[] = RESOURCE_SOURCES,
): BuildSchedulingMatrixResult {
  const primaryColumns: string[] = [];
  const pendingRows: PendingRow[] = [];

  for (const booking of input.bookings) {
    primaryColumns.push(primaryFor(booking.bookingId));
    booking.candidates.forEach((slot, idx) => {
      pendingRows.push({
        rowId: rowFor(booking.bookingId, idx),
        bookingId: booking.bookingId,
        slot,
      });
    });
  }

  // console.log('pendingRows:', pendingRows);

  const secondaryColumns: string[] = [];
  const secondaryCellsByRow = new Map<string, string[]>();
  for (const source of resourceSources) {
    const { columnIds, cellsByRow } = source(pendingRows);
    secondaryColumns.push(...columnIds);
    for (const [rowId, cells] of cellsByRow) {
      const prior = secondaryCellsByRow.get(rowId);
      secondaryCellsByRow.set(rowId, prior ? [...prior, ...cells] : cells);
    }
  }

  const rowSpecs: RowSpec[] = pendingRows.map((r) => ({
    rowId: r.rowId,
    columns: [
      primaryFor(r.bookingId),
      ...(secondaryCellsByRow.get(r.rowId) ?? []),
    ],
  }));

  const matrix = buildMatrix(primaryColumns, secondaryColumns, rowSpecs);

  const lookup = new Map<string, { bookingId: string; slot: SlotCandidate }>();
  for (const r of pendingRows) {
    lookup.set(r.rowId, { bookingId: r.bookingId, slot: r.slot });
  }

  // console.log('built matrix: ');
  // printMatrix(matrix);

  return {
    matrix,
    resolveRow: (rowId) => lookup.get(rowId),
  };
}
