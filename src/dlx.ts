// Knuth's Algorithm X with the Dancing Links data structure (DLX), including
// the XCC extension for secondary (at-most-once) constraints.
//
// Reference: Knuth, "Dancing Links" (2000); TAOCP 4B §7.2.2.1.
//
// The matrix is represented as a sparse doubly-linked structure. Each cell
// is a node with four pointers (up/down/left/right) plus a reference to its
// column header. A column header is itself a node; the per-column up/down
// chain is circular through the header, so iterating cells in a column
// terminates when we walk back to the header. The same holds for the
// horizontal cell list within a row.
//
// `cover(c)` removes a column header from the header list and removes every
// row that has a cell in `c` from the data structure. `uncover(c)` is the
// exact reverse, walking the matrix in the opposite direction. Because the
// removed nodes retain valid pointers to their old neighbors (we just splice
// past them; we don't zero them out), uncover is O(1) per node — that's
// "dancing links," the property that makes Algorithm X efficient.
//
// XCC: primary columns must be covered exactly once. Secondary columns may
// be covered at most once. Practically, secondary columns are NOT placed
// in the header ring (so `chooseColumn` never picks them as a branch), but
// they ARE covered when a row containing them is selected (so any later
// row that would re-cover them is excluded). This is how "no provider
// double-booked in this interval" gets expressed.

// ── Types ────────────────────────────────────────────────────────────────────

export interface DataNode {
  up: DataNode;
  down: DataNode;
  left: DataNode;
  right: DataNode;
  column: ColumnHeader;
  /** Stable identifier of the row this cell belongs to. */
  rowId: string;
}

export interface ColumnHeader extends DataNode {
  /** Stable identifier of the column. */
  name: string;
  /** Count of cells currently in the column (for the S-heuristic). */
  size: number;
  /** True for exactly-once columns; false for at-most-once (XCC secondary). */
  isPrimary: boolean;
}

export interface Matrix {
  /** Sentinel column header. `root.right` walks the live primary columns. */
  root: ColumnHeader;
  /** Direct lookup by column name. Includes both primary and secondary. */
  columnsByName: Map<string, ColumnHeader>;
}

/** Specification for a single row to insert into the matrix. */
export interface RowSpec {
  /** Stable identifier for the row. Surfaced in the solution. */
  rowId: string;
  /** Names of columns this row covers. Order is preserved in the row's
   *  left/right linkage. */
  columns: string[];
}

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Build a DLX matrix from a row-based specification.
 *
 * @param primaryColumns   Column names that must be covered exactly once.
 * @param secondaryColumns Column names that may be covered at most once.
 *                         Pass [] if the problem has no secondary constraints.
 * @param rows             Each row names the columns it covers. Every named
 *                         column must exist in primaryColumns or
 *                         secondaryColumns; an unknown column throws.
 */
export function buildMatrix(
  primaryColumns: readonly string[],
  secondaryColumns: readonly string[],
  rows: readonly RowSpec[]
): Matrix {
  const root = makeSentinelHeader();
  const columnsByName = new Map<string, ColumnHeader>();

  // Primary columns are linked into the header ring. Secondary columns are
  // not — they're reachable only via their cells.
  for (const name of primaryColumns) {
    const header = makeColumnHeader(name, true);
    appendHeaderToRing(root, header);
    columnsByName.set(name, header);
  }
  for (const name of secondaryColumns) {
    const header = makeColumnHeader(name, false);
    // Secondary header is its own little ring (self-linked left/right);
    // it stays out of the root's primary ring.
    columnsByName.set(name, header);
  }

  for (const row of rows) {
    insertRow(row, columnsByName);
  }

  return { root, columnsByName };
}

function makeSentinelHeader(): ColumnHeader {
  const header = {
    name: '__root__',
    size: 0,
    isPrimary: true,
    rowId: '__root__',
  } as Partial<ColumnHeader> as ColumnHeader;
  // Self-linked in all four directions; cells get spliced in later.
  header.up = header;
  header.down = header;
  header.left = header;
  header.right = header;
  header.column = header;
  return header;
}

function makeColumnHeader(name: string, isPrimary: boolean): ColumnHeader {
  const header = {
    name,
    size: 0,
    isPrimary,
    rowId: `__col_${name}__`,
  } as Partial<ColumnHeader> as ColumnHeader;
  header.up = header;
  header.down = header;
  header.left = header;
  header.right = header;
  header.column = header;
  return header;
}

function appendHeaderToRing(root: ColumnHeader, header: ColumnHeader): void {
  // Splice header in just before root, i.e. at the right end of the ring.
  header.left = root.left;
  header.right = root;
  root.left.right = header;
  root.left = header;
}

function insertRow(row: RowSpec, columnsByName: Map<string, ColumnHeader>): void {
  const cells: DataNode[] = [];
  for (const colName of row.columns) {
    const column = columnsByName.get(colName);
    if (!column) {
      throw new Error(`buildMatrix: row "${row.rowId}" references unknown column "${colName}"`);
    }
    const cell = {
      column,
      rowId: row.rowId,
    } as Partial<DataNode> as DataNode;
    // Splice cell into the column's vertical ring (at the bottom, i.e.
    // just above the header).
    cell.up = column.up;
    cell.down = column;
    column.up.down = cell;
    column.up = cell;
    column.size += 1;
    cells.push(cell);
  }
  // Link the cells horizontally into a circular ring.
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const next = cells[(i + 1) % cells.length]!;
    cell.right = next;
    next.left = cell;
  }
}

// ── Cover / uncover (the dance) ──────────────────────────────────────────────

/**
 * Remove a column header from the header ring and remove every row that has
 * a cell in this column from the data structure. The removed nodes retain
 * pointers to their old neighbors so that `uncover` can splice them back
 * in O(1) per node.
 */
export function cover(c: ColumnHeader): void {
  c.right.left = c.left;
  c.left.right = c.right;
  for (let r = c.down; r !== c; r = r.down) {
    for (let j = r.right; j !== r; j = j.right) {
      j.down.up = j.up;
      j.up.down = j.down;
      j.column.size -= 1;
    }
  }
}

/** Exact reverse of `cover`. Must be invoked in reverse order of covers. */
export function uncover(c: ColumnHeader): void {
  for (let r = c.up; r !== c; r = r.up) {
    for (let j = r.left; j !== r; j = j.left) {
      j.column.size += 1;
      j.down.up = j;
      j.up.down = j;
    }
  }
  c.right.left = c;
  c.left.right = c;
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /**
   * Invoked each time a complete cover is found. Return `true` to stop
   * searching, `false` to keep enumerating other covers. Default behavior
   * (no callback supplied) stops at the first solution.
   *
   * The argument is a *snapshot* of the current solution row set — safe to
   * keep references to (rowIds are stable strings); the underlying DataNodes
   * may be mutated by subsequent search steps so don't read pointer fields
   * from them after the callback returns.
   */
  onSolution?: (rowIds: readonly string[]) => boolean;
}

/**
 * Run Algorithm X with the S-heuristic (always branch on the smallest
 * primary column first). Returns all collected row-id sets, in the order
 * the callback accepted them. If no callback is supplied, returns the
 * first solution only (or an empty array if none exists).
 */
export function search(matrix: Matrix, options: SearchOptions = {}): string[][] {
  const stopAtFirst = options.onSolution === undefined;
  const onSolution = options.onSolution ?? (() => true);
  const solutions: string[][] = [];
  const stack: DataNode[] = [];

  const recurse = (): boolean => {
    if (matrix.root.right === matrix.root) {
      const snapshot = stack.map((node) => node.rowId);
      solutions.push(snapshot);
      const shouldStop = onSolution(snapshot);
      return shouldStop;
    }
    const c = chooseColumn(matrix);
    if (c.size === 0) return false;
    cover(c);
    for (let r = c.down; r !== c; r = r.down) {
      stack.push(r);
      for (let j = r.right; j !== r; j = j.right) cover(j.column);
      const shouldStop = recurse();
      for (let j = r.left; j !== r; j = j.left) uncover(j.column);
      stack.pop();
      if (shouldStop) {
        uncover(c);
        return true;
      }
    }
    uncover(c);
    return false;
  };

  recurse();
  return stopAtFirst && solutions.length > 1 ? solutions.slice(0, 1) : solutions;
}

/** S-heuristic: pick the live primary column with the smallest size. */
function chooseColumn(matrix: Matrix): ColumnHeader {
  let best = matrix.root.right as ColumnHeader;
  for (let c = best.right as ColumnHeader; c !== matrix.root; c = c.right as ColumnHeader) {
    if (c.size < best.size) best = c;
  }
  return best;
}

// ── Diagnostics (helpful for tests) ──────────────────────────────────────────

/**
 * Walk the matrix and verify the structural invariants. Throws on the first
 * inconsistency. Intended for use in tests after non-trivial sequences of
 * cover/uncover or after construction; not for hot paths.
 *
 * Invariants checked:
 *   1. For every cell x: x.left.right === x and x.right.left === x.
 *   2. For every cell x: x.up.down === x and x.down.up === x.
 *   3. For every column header c: c.size equals the count of cells
 *      reachable by walking c.down until back to c.
 */
export function assertMatrixInvariants(matrix: Matrix): void {
  for (const [name, c] of matrix.columnsByName) {
    let count = 0;
    for (let cell = c.down; cell !== c; cell = cell.down) {
      count += 1;
      if (cell.up.down !== cell) {
        throw new Error(`Column "${name}": cell's up.down !== cell`);
      }
      if (cell.down.up !== cell) {
        throw new Error(`Column "${name}": cell's down.up !== cell`);
      }
      if (cell.left.right !== cell) {
        throw new Error(`Column "${name}": cell's left.right !== cell`);
      }
      if (cell.right.left !== cell) {
        throw new Error(`Column "${name}": cell's right.left !== cell`);
      }
    }
    if (count !== c.size) {
      throw new Error(`Column "${name}": size says ${c.size}, walked ${count}`);
    }
  }
}
