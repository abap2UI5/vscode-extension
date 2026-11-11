/*
 * The arithmetic behind `npm run test:coverage` (scripts/coverage.mjs), kept
 * apart from the file system so `src/test/coverage.test.ts` can pin it.
 *
 * Why this exists instead of `node --test --experimental-test-coverage`: the
 * suite runs BUNDLES (`dist-test/*.test.cjs`), and that reporter's view
 * through a source map is range-based - it maps the two ends of every V8
 * range and marks whole stretches of the original file. Comment and type-only
 * lines end up counted, as covered in one module and as uncovered in the next
 * (`src/text.ts`, every line of code executed, came out at 9 of 22 lines),
 * and this codebase is half comments. So the collection is still Node's own
 * (`NODE_V8_COVERAGE`), and only the reading of it is done here, per source
 * map SEGMENT: a line of `src/` counts when the bundler emitted code for it,
 * and it is covered when V8 executed one of the places that code went to.
 */

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Map([...BASE64].map((ch, i) => [ch, i]));

/**
 * The segments of a source map's `mappings` string that name a source
 * position, as flat `[generatedLine, generatedColumn, sourceIndex,
 * sourceLine]` quadruples (all 0-based). Segments without a source (one
 * field) are skipped; the name index is read and ignored.
 */
export function decodeMappings(mappings) {
  const out = [];
  let genLine = 0;
  let genCol = 0;
  let source = 0;
  let srcLine = 0;
  let field = 0;
  let value = 0;
  let shift = 0;
  let fields = [0, 0, 0, 0, 0];
  const endSegment = () => {
    if (field === 0) {
      return;
    }
    genCol += fields[0];
    if (field >= 4) {
      source += fields[1];
      srcLine += fields[2];
      out.push(genLine, genCol, source, srcLine);
    }
    field = 0;
    fields = [0, 0, 0, 0, 0];
  };
  for (const ch of mappings) {
    if (ch === ",") {
      endSegment();
    } else if (ch === ";") {
      endSegment();
      genLine++;
      genCol = 0;
    } else {
      const digit = BASE64_VALUE.get(ch);
      if (digit === undefined) {
        throw new Error(`not a base64 VLQ digit: ${JSON.stringify(ch)}`);
      }
      value += (digit & 31) * 2 ** shift;
      if (digit & 32) {
        shift += 5;
      } else {
        const negative = value % 2 === 1;
        const magnitude = Math.floor(value / 2);
        fields[field++] = negative ? -magnitude : magnitude;
        value = 0;
        shift = 0;
      }
    }
  }
  endSegment();
  return out;
}

/** The offset each line of `text` starts at (offsets as V8 counts them:
 *  UTF-16 code units, which is also what the bundler's columns are). */
export function lineOffsets(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

/**
 * How often each offset of a script ran, out of the `functions` V8 reports
 * for it. V8's ranges nest (a function, the blocks inside it), and the
 * innermost one is the one that speaks for an offset - so they are painted
 * widest first. An offset no range covers was never compiled: 0.
 *
 * `into` accumulates over several reports of the same script (two processes
 * that loaded it): an offset is as covered as the report that ran it most.
 */
export function executionCounts(functions, length, into) {
  const counts = new Uint32Array(length);
  const ranges = functions.flatMap((fn) => fn.ranges);
  ranges.sort(
    (a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset)
  );
  for (const range of ranges) {
    counts.fill(
      Math.min(range.count, 0xffffffff),
      Math.max(0, range.startOffset),
      Math.min(length, range.endOffset)
    );
  }
  if (into) {
    for (let i = 0; i < length; i++) {
      if (into[i] > counts[i]) {
        counts[i] = into[i];
      }
    }
  }
  return counts;
}

/**
 * Adds one bundle to the tally: `lines` maps a source (as the map names it)
 * to a `Map<lineNumber (1-based), covered>`. A line is in the map when a
 * segment points at it, and covered when the generated code of any such
 * segment ran.
 */
export function tallyBundle(lines, map, code, counts) {
  const starts = lineOffsets(code);
  const segments = decodeMappings(map.mappings);
  for (let i = 0; i < segments.length; i += 4) {
    const source = map.sources[segments[i + 2]];
    if (source === undefined || segments[i] >= starts.length) {
      continue;
    }
    const offset = starts[segments[i]] + segments[i + 1];
    const ran = offset < counts.length && counts[offset] > 0;
    let perLine = lines.get(source);
    if (!perLine) {
      lines.set(source, (perLine = new Map()));
    }
    const line = segments[i + 3] + 1;
    perLine.set(line, perLine.get(line) === true || ran);
  }
}

/** `{ file, covered, total, percent }` per source, least covered first (ties:
 *  the larger module first, then by name). */
export function summarize(lines) {
  const rows = [];
  for (const [file, perLine] of lines) {
    let covered = 0;
    for (const ran of perLine.values()) {
      if (ran) {
        covered++;
      }
    }
    rows.push({ file, covered, total: perLine.size, percent: percentOf(covered, perLine.size) });
  }
  return rows.sort(
    (a, b) =>
      a.percent - b.percent || b.total - a.total || a.file.localeCompare(b.file)
  );
}

/** The lines of one module that have code and did not run, as ranges:
 *  `"3-5, 9"`. Empty when every line ran. */
export function uncoveredLines(perLine) {
  const missed = [...perLine]
    .filter(([, ran]) => !ran)
    .map(([line]) => line)
    .sort((a, b) => a - b);
  const ranges = [];
  for (const line of missed) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === line - 1) {
      last[1] = line;
    } else {
      ranges.push([line, line]);
    }
  }
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ");
}

export function percentOf(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

export function totalOf(rows) {
  const covered = rows.reduce((sum, row) => sum + row.covered, 0);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return { covered, total, percent: percentOf(covered, total) };
}

const pct = (value) => `${value.toFixed(1)}%`;

/** The table for a terminal: aligned columns, one module per line. */
export function textTable(rows) {
  const all = totalOf(rows);
  const width = Math.max(4, ...rows.map((row) => row.file.length));
  const line = (file, percent, covered, total) =>
    `${file.padEnd(width)}  ${percent.padStart(7)}  ${String(covered).padStart(7)}  ${String(total).padStart(6)}`;
  return [
    line("file", "lines", "covered", "total"),
    line("-".repeat(width), "-------", "-------", "------"),
    ...rows.map((row) => line(row.file, pct(row.percent), row.covered, row.total)),
    line("-".repeat(width), "-------", "-------", "------"),
    line("all", pct(all.percent), all.covered, all.total),
  ].join("\n");
}

/** The same table for a GitHub job summary. */
export function markdownTable(rows) {
  const all = totalOf(rows);
  return [
    "| Module | Lines | Covered | Total |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(
      (row) => `| \`${row.file}\` | ${pct(row.percent)} | ${row.covered} | ${row.total} |`
    ),
    `| **all** | **${pct(all.percent)}** | ${all.covered} | ${all.total} |`,
  ].join("\n");
}
