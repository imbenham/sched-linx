import Link from 'next/link';
import { PROSE_CLASSES } from '@/app/_constants';

export default function ScenariosIndex() {
  return (
    <article className={PROSE_CLASSES}>
      <h1>Scenarios</h1>
      <p>
        Each scenario demonstrates a different scheduling problem and the
        knobs you can turn — service mix, provider qualifications, room
        constraints, booking modes — to see how the DLX-based picker
        handles it. The underlying algorithm and data structures don't
        change between scenarios; only the seeded inputs do.
      </p>

      <h2 className="mt-8">
        <Link href="/scenarios/scenario1">
          1. Three-provider practice (no rooms)
        </Link>
      </h2>
      <p>
        A simple 3-provider practice with overlapping qualifications and
        three service types. Demonstrates anonymous vs. known-provider
        booking modes and reshuffle-aware availability. No room
        constraints — services are eligible for any provider that's
        qualified and free.
      </p>

      <h2 className="mt-8">
        <Link href="/scenarios/scenario2">
          2. Practice with room constraints
        </Link>
      </h2>
      <p>
        Adds physical room availability as a scheduling constraint. The
        imaging service can only happen in an imaging-typed room; other
        services are room-agnostic. Demonstrates how a new constraint
        axis plugs into the same matrix without algorithm changes.
      </p>

      <h2 className="mt-8">
        <Link href="/scenarios/scenario3">
          3. Mixed telehealth + in-person
        </Link>
      </h2>
      <p>
        A practice offering both telehealth and in-person visits in the
        same booking flow. Telehealth services don't consume a room;
        in-person services do. Exercises the "room constraint is
        conditional, not universal" path through the matrix.
      </p>

      <h2 className="mt-8">
        <Link href="/scenarios/scenario4">
          4. Pure urgent care (location-scheduled)
        </Link>
      </h2>
      <p>
        Walk-in clinic paradigm. No providers, no rooms — just a
        location with a nominal concurrent capacity. Booking is a direct
        count against pinned overlaps at that location; when the
        capacity's full, further bookings for that window are
        infeasible. The smallest sched-linx scenario, and deliberately
        so: it establishes what location-scheduled means before the
        interesting composition arrives in scenario 5.
      </p>

      <h2 className="mt-8">
        <Link href="/scenarios/scenario5">
          5. Mixed practice (urgent care + specialty sharing rooms)
        </Link>
      </h2>
      <p>
        Where the substrate earns its keep. Urgent care and specialty
        visits run out of the same building, and both compete for the
        same physical rooms. Urgent care is location-scheduled; specialty
        is provider-scheduled. Rooms are the connecting constraint —
        when specialty holds an exam room, urgent care's effective
        capacity drops even though the nominal number hasn't. Two
        booking paradigms, one shared resource pool.
      </p>
    </article>
  );
}
