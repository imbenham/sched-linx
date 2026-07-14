// View-only types — anything that has a canonical equivalent in
// `src/model.ts` should NOT live here; import it from there instead.
// What stays here is genuinely UI-shaped data (display labels, render
// state, action response envelopes).

import type { Slot } from '@/src/model';
import { ReshuffleProposal } from '@/src/scheduling/proposeReshuffle';

export interface TimeSlot {
  label: string;
  isoStart: string;
}

// Aggregate availability across all qualified providers at a single
// time slot — used in anonymous mode where the calendar collapses to
// one column. "available" iff at least one qualified provider could
// take a full-duration booking starting here. "no-providers" iff some
// provider's schedule covers the time but all of them are busy.
// "out-of-day" iff no qualified provider is even scheduled at this time.
// `bookedCount` on `available` reflects how many bookings have already
// landed on this slot at the currently-scoped location (undefined for
// the provider-scheduled anonymous path, which doesn't collapse by
// capacity). Used to render "Booked x N" so the user sees confirmation
// even when the slot has room for more.
export type AnonymousCalendarCellState = { kind: 'available'; bookedCount?: number } | { kind: 'unavailable' } | { kind: 'out-of-day' } | { kind: 'unavailable-reshufflable', proposal: ReshuffleProposal };

// `unavailable` carries the blocking pin when the conflict is on the
// provider axis (covered / would-overlap). The 'no-room' branch means
// the provider is free at this cell, but every eligible room is held by
// some pin (or no eligible rooms exist) — multiple pins may be involved
// so we don't surface a single booking.
export type CalendarCellState =
  | { kind: 'out-of-schedule' }
  | { kind: 'available' }
  | { kind: 'busy-start'; booking: Slot }
  | { kind: 'unavailable'; reason: 'covered' | 'would-overlap'; booking: Slot }
  | { kind: 'unavailable'; reason: 'no-room' };
