import Link from 'next/link';
import { PROSE_CLASSES } from './_constants';

export default function Page() {
  return (
    <article className={PROSE_CLASSES}>
      <h1>Dancing Links and Healthcare Scheduling</h1>

      <p>
        When I was learning to code, the very first thing I "shipped" was an iOS application that generated Sudoku puzzles. The generation algorithm was a (very green software dev's) implementation of{' '}
        <a
          href="https://en.wikipedia.org/wiki/Knuth%27s_Algorithm_X"
          target="_blank"
          rel="noopener noreferrer"
        >
          Donald Knuth's &ldquo;Dancing Links&rdquo; algorithm
        </a>
        {' '}for solving exact cover problems. I was fascinated by the way the algorithm could efficiently explore a huge combinatorial search space by cleverly <em>dancing</em> rows in and out of a matrix representation of the problem.
      </p>

      <p>
        Years later, I found myself working on scheduling problems in the healthcare space, and realized that the general shape of those problems was often similar to the exact cover problems Dancing Links solved — it was a matter of selecting the right combination of resources to meet a set of constraints.
      </p>

      <p>
        Moreover, while the basic scheduling atom is the same — a timeslot needs to be matched to a provider capable of filling that timeslot — the number of additional constraints that can be added on top of that fundamental problem is vast: provider qualifications, patient preferences, equipment availability, room capacity, and more. The possibilities are as varied as the landscape of clinical contexts.
      </p>

      <p>
        Without a clear framework for extensibility, a scheduling system can be stressed each time a new constraint is added, and its ability to adapt to new contexts can be limited. Core logic may need to be refactored, making the new behavior not only time-consuming to add, but potentially risky if it touches existing functionality that other practices rely on.
      </p>

      <p>
        This is what really piqued my interest in using Dancing Links as a foundation for a scheduling system: its flexibility in accommodating a wide range of constraints, and its efficiency in navigating complex search spaces.
      </p>

      <p>
        Instead of risky rewrites, what if additional constraints could be folded into the same underlying algorithmic framework, without needing to change the core implementation? That's the idea being explored in this prototype: a scheduling system built on top of the Dancing Links algorithm, designed to be flexible and extensible enough to accommodate the wide range of constraints the real world tends to throw at you.
      </p>

      <hr />

      <p>
        <Link href="/scenarios">Explore the scenarios →</Link>
      </p>
    </article>
  );
}
