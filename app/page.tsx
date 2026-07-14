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

      <p>
        The <Link href="/scenarios">scenarios pages</Link> explore a variety of scheduling contexts and show how the data model can be customized to solve different real world problems of increasing complexity. The scenarios are seeded with data that represents different practice configurations, and the scheduling logic is exercised against those configurations to demonstrate how the system can adapt to different constraints. The scheduling experiences built on the implementations are interactive, so you can see how the system behaves under different conditions and make it a bit less abstract.
      </p>
      <p>
        Another idea explored in the <Link href="/agentic-onboarding">agentic onboarding page</Link> is how an LLM can act as the concierge and interpreter between a user who knows their business case front to back, but wouldn't necessarily know how to translate it to a concrete composition of the scheduling primitives defined by the system to solve their business case. In the real world, this can be a frustrating and costly process carried out by a group of stakeholders who deal in different abstractions. A couple of mock interactions are seeded to show how a user-agent dialog can produce a plan and then instantiate it. Users who want to go deeper can{' '}
        <a
          href="https://github.com/imbenham/sched-linx"
          target="_blank"
          rel="noopener noreferrer"
        >
          clone the repo
        </a>{' '}
        and provide their own Anthropic API key to explore the agentic onboarding experience in a more open-ended way.
      </p>

      <hr />

      <p>
        <Link href="/scenarios">Explore the scenarios →</Link>
      </p>
    </article>
  );
}
