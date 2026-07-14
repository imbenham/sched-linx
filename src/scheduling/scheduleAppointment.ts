// The orchestration layer — ties loadSchedulingContext + pickSlot +
// proposeReshuffle + applyAssignment into a single "schedule this
// request" call. Returns a discriminated union so callers (server
// actions, future Express, batch scripts) can branch on outcome without
// re-running the algorithm.

import { applyAssignment, loadSchedulingContext } from '../db/repository';
import type { Database } from '../db/client';
import { pickSlot } from './pickSlot';
import {
  proposeReshuffle,
  type ReshuffleProposal,
} from './proposeReshuffle';
import type {
  BookingRequest,
  ProviderId,
  Slot,
  SlotCandidate,
} from '../model';

export type ScheduleResult =
  | {
      kind: 'direct';
      assignment: {
        // Undefined for location-scheduled bookings — the assignment
        // holds a location + optional room, not a provider.
        providerId?: ProviderId;
        slot: SlotCandidate;
        booking: Slot;
      };
    }
  | { kind: 'proposal'; proposal: ReshuffleProposal }
  | { kind: 'infeasible' };

// Try the cheap path first (pickSlot). For provider-scheduled services,
// fall back to proposeReshuffle on failure. Location-scheduled services
// skip reshuffle — capacity-based booking has no coherent "move an
// existing pin to free me up" story. On direct pick, commit the
// assignment so the caller doesn't have to.
//
// `tag` scopes both the read (loadSchedulingContext) and the write
// (applyAssignment) to a single scenario. Omit it to operate over the
// whole database (legacy callers, tests).
export async function scheduleAppointment(
  db: Database,
  request: BookingRequest,
  tag?: string,
): Promise<ScheduleResult> {
  const ctx = await loadSchedulingContext(db, tag);

  const direct = pickSlot(request, ctx);
  if (direct) {
    const { slot } = await applyAssignment(db, direct.slot, tag);
    return {
      kind: 'direct',
      assignment: {
        providerId: direct.providerId,
        slot: direct.slot,
        booking: slot,
      },
    };
  }

  // Reshuffle is provider-scheduled only. Location-scheduled services
  // that fail pickSlot fall straight through to infeasible.
  const service = ctx.services.find((s) => s.id === request.serviceId);
  if (service?.requiresProvider) {
    const proposal = proposeReshuffle(request, ctx);
    if (proposal) return { kind: 'proposal', proposal };
  }

  return { kind: 'infeasible' };
}
