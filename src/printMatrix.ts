import type { ColumnHeader, Matrix } from './dlx';

const INDENT = '  ';
const COL_WIDTH = 3;

const padCol = (s: string): string => s.padStart(COL_WIDTH);

// Render a Matrix as a human-readable ASCII table for debugging and
// learning. Walks the matrix's live structure — primary columns from the
// root ring (skips covered columns), secondary columns from columnsByName,
// rows from each column's down-chain.
//
// Intended for static dumps (e.g. immediately after buildMatrix). Calling
// this mid-search is supported but the output reflects the partially
// covered state DLX is currently in.
export function formatMatrix(matrix: Matrix): string {
  const primary: ColumnHeader[] = [];
  for (
    let c = matrix.root.right as ColumnHeader;
    c !== matrix.root;
    c = c.right as ColumnHeader
  ) {
    primary.push(c);
  }

  // Map iteration is insertion order; secondary columns come after primary.
  const secondary: ColumnHeader[] = [];
  for (const col of matrix.columnsByName.values()) {
    if (!col.isPrimary) secondary.push(col);
  }

  const primaryLabel = new Map<ColumnHeader, string>();
  primary.forEach((col, i) => primaryLabel.set(col, `P${i}`));

  const secondaryLabel = new Map<ColumnHeader, string>();
  secondary.forEach((col, i) => secondaryLabel.set(col, `S${i}`));

  // Collect rows by walking each column's down-chain.
  const rowToCols = new Map<string, Set<ColumnHeader>>();
  for (const col of [...primary, ...secondary]) {
    for (let cell = col.down; cell !== col; cell = cell.down) {
      let cols = rowToCols.get(cell.rowId);
      if (!cols) {
        cols = new Set();
        rowToCols.set(cell.rowId, cols);
      }
      cols.add(col);
    }
  }

  const rowIds = [...rowToCols.keys()];

  const lines: string[] = [];
  lines.push(
    `Matrix [${primary.length} primary, ${secondary.length} secondary, ${rowIds.length} rows]`,
  );

  if (primary.length > 0) {
    lines.push('');
    lines.push('Primary columns (exactly-once):');
    for (const col of primary) {
      lines.push(
        `${INDENT}${primaryLabel.get(col)!} = ${col.name}  size=${col.size}`,
      );
    }
  }

  if (secondary.length > 0) {
    lines.push('');
    lines.push('Secondary columns (at-most-once):');
    for (const col of secondary) {
      lines.push(
        `${INDENT}${secondaryLabel.get(col)!} = ${col.name}  size=${col.size}`,
      );
    }
  }

  if (rowIds.length > 0) {
    const rowIdW = Math.max(...rowIds.map((id) => id.length));
    const sep = secondary.length > 0 ? '  |' : '';

    const primaryHeader = primary
      .map((c) => padCol(primaryLabel.get(c)!))
      .join('');
    const secondaryHeader = secondary
      .map((c) => padCol(secondaryLabel.get(c)!))
      .join('');

    lines.push('');
    lines.push('Cells (X = present, . = absent):');
    lines.push(
      `${INDENT}${' '.repeat(rowIdW)}${primaryHeader}${sep}${secondaryHeader}`,
    );

    for (const rowId of rowIds) {
      const cols = rowToCols.get(rowId)!;
      const primaryRow = primary
        .map((c) => padCol(cols.has(c) ? 'X' : '.'))
        .join('');
      const secondaryRow = secondary
        .map((c) => padCol(cols.has(c) ? 'X' : '.'))
        .join('');
      lines.push(
        `${INDENT}${rowId.padEnd(rowIdW)}${primaryRow}${sep}${secondaryRow}`,
      );
    }
  }

  return lines.join('\n');
}

export function printMatrix(matrix: Matrix): void {
  console.log(formatMatrix(matrix));
}
