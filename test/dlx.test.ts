import { describe, expect, it } from 'vitest';
import { assertMatrixInvariants, buildMatrix, cover, search, uncover, type Matrix, type RowSpec } from '../src/dlx.js';

// ── Knuth's classic exact-cover example ──────────────────────────────────────
//
// From the Dancing Links paper. Seven columns (A..G), six rows. Exactly one
// solution exists: rows 1, 4, 5 (cover all seven columns once).
//
//   row 1: C E F
//   row 2: A D G
//   row 3: B C F
//   row 4: A D
//   row 5: B G
//   row 6: D E G

describe('Knuth classic exact-cover example', () => {
  const buildKnuthMatrix = (): Matrix =>
    buildMatrix(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      [],
      [
        { rowId: 'r1', columns: ['C', 'E', 'F'] },
        { rowId: 'r2', columns: ['A', 'D', 'G'] },
        { rowId: 'r3', columns: ['B', 'C', 'F'] },
        { rowId: 'r4', columns: ['A', 'D'] },
        { rowId: 'r5', columns: ['B', 'G'] },
        { rowId: 'r6', columns: ['D', 'E', 'G'] },
      ]
    );

  it('finds the unique solution {r1, r4, r5}', () => {
    const matrix = buildKnuthMatrix();
    const solutions = search(matrix);
    expect(solutions).toHaveLength(1);
    expect(solutions[0]!.sort()).toEqual(['r1', 'r4', 'r5']);
  });

  it('enumeration finds exactly one solution', () => {
    const matrix = buildKnuthMatrix();
    const enumerated: string[][] = [];
    search(matrix, {
      onSolution: (rowIds) => {
        enumerated.push([...rowIds].sort());
        return false; // keep enumerating
      },
    });
    expect(enumerated).toHaveLength(1);
    expect(enumerated[0]).toEqual(['r1', 'r4', 'r5']);
  });

  it('matrix invariants hold after construction', () => {
    const matrix = buildKnuthMatrix();
    expect(() => assertMatrixInvariants(matrix)).not.toThrow();
  });
});

// ── No-solution case ─────────────────────────────────────────────────────────

describe('no-solution problems', () => {
  it('returns empty when a primary column has no rows', () => {
    const matrix = buildMatrix(
      ['A', 'B'],
      [],
      [{ rowId: 'r1', columns: ['A'] }]
    );
    expect(search(matrix)).toEqual([]);
  });

  it('returns empty when constraints make any selection conflict', () => {
    // Two primary columns A, B. The only rows that cover B also conflict on
    // secondary column S, so no valid combination covers both A and B.
    const matrix = buildMatrix(
      ['A', 'B'],
      ['S'],
      [
        { rowId: 'rA', columns: ['A', 'S'] },
        { rowId: 'rB1', columns: ['B', 'S'] },
        { rowId: 'rB2', columns: ['B', 'S'] },
      ]
    );
    expect(search(matrix)).toEqual([]);
  });
});

// ── N-queens (exercises XCC / secondary columns) ─────────────────────────────
//
// Exact-cover formulation:
//   Primary columns:
//     R1..RN   — exactly one queen per rank
//     F1..FN   — exactly one queen per file
//   Secondary columns:
//     D(r-f)   — at most one queen per (-) diagonal (rank - file is constant)
//     A(r+f)   — at most one queen per (+) anti-diagonal
//   Rows:
//     One per (rank, file) placement, covering its rank, file, diagonal, and
//     anti-diagonal columns.

function buildNQueens(n: number): Matrix {
  const primary: string[] = [];
  const secondary: string[] = [];
  for (let r = 1; r <= n; r++) primary.push(`R${r}`);
  for (let f = 1; f <= n; f++) primary.push(`F${f}`);
  for (let d = -(n - 1); d <= n - 1; d++) secondary.push(`D${d}`);
  for (let a = 2; a <= 2 * n; a++) secondary.push(`A${a}`);

  const rows: RowSpec[] = [];
  for (let r = 1; r <= n; r++) {
    for (let f = 1; f <= n; f++) {
      rows.push({
        rowId: `Q(${r},${f})`,
        columns: [`R${r}`, `F${f}`, `D${r - f}`, `A${r + f}`],
      });
    }
  }
  return buildMatrix(primary, secondary, rows);
}

describe('N-queens via DLX', () => {
  it('N=4 has exactly 2 solutions', () => {
    const matrix = buildNQueens(4);
    const solutions: string[][] = [];
    search(matrix, {
      onSolution: (rowIds) => {
        solutions.push([...rowIds].sort());
        return false;
      },
    });
    expect(solutions).toHaveLength(2);
    // Sanity check that each solution places exactly 4 queens.
    for (const sol of solutions) {
      expect(sol).toHaveLength(4);
    }
  });

  it('N=8 has the canonical 92 solutions', () => {
    const matrix = buildNQueens(8);
    let count = 0;
    search(matrix, {
      onSolution: () => {
        count += 1;
        return false;
      },
    });
    expect(count).toBe(92);
  });

  it('stop-at-first returns one solution for N=8', () => {
    const matrix = buildNQueens(8);
    const solutions = search(matrix); // no callback => stop at first
    expect(solutions).toHaveLength(1);
    expect(solutions[0]).toHaveLength(8);
  });
});

// ── Structural invariants under cover/uncover ────────────────────────────────

describe('cover/uncover round-trip', () => {
  it('matrix is structurally identical after cover(c); uncover(c)', () => {
    const matrix = buildMatrix(
      ['A', 'B', 'C'],
      ['S'],
      [
        { rowId: 'r1', columns: ['A', 'B'] },
        { rowId: 'r2', columns: ['A', 'C', 'S'] },
        { rowId: 'r3', columns: ['B', 'C', 'S'] },
      ]
    );
    const before = snapshotSizes(matrix);
    expect(() => assertMatrixInvariants(matrix)).not.toThrow();

    const A = matrix.columnsByName.get('A')!;
    cover(A);
    uncover(A);

    expect(() => assertMatrixInvariants(matrix)).not.toThrow();
    expect(snapshotSizes(matrix)).toEqual(before);
  });

  it('nested cover/uncover preserves invariants', () => {
    const matrix = buildMatrix(
      ['A', 'B', 'C'],
      ['S'],
      [
        { rowId: 'r1', columns: ['A', 'B'] },
        { rowId: 'r2', columns: ['A', 'C', 'S'] },
        { rowId: 'r3', columns: ['B', 'C', 'S'] },
      ]
    );
    const before = snapshotSizes(matrix);

    const A = matrix.columnsByName.get('A')!;
    const B = matrix.columnsByName.get('B')!;
    cover(A);
    cover(B);
    uncover(B);
    uncover(A);

    expect(() => assertMatrixInvariants(matrix)).not.toThrow();
    expect(snapshotSizes(matrix)).toEqual(before);
  });
});

function snapshotSizes(matrix: Matrix): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const [name, col] of matrix.columnsByName) {
    sizes[name] = col.size;
  }
  return sizes;
}
