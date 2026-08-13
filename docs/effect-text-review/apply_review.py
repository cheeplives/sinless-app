#!/usr/bin/env python3
"""Write REVIEW.md's Proposed text into static/data.js, cell by cell.

This is the last script this bundle runs. Everything before it (probe, verify,
check_originals) exists to make this step safe: by the time it runs, every
Original has been proven to match data.js exactly -- by name, as a multiset,
and IN ORDER -- and every parser-visible change has been proven declared.

That last guarantee, position, is also how this script finds each cell. Name
matching alone is not enough (a martial-art style names six rows), so for each
(table, column) this walks data.js's rows for that table IN FILE ORDER, keeps
the ones where the column is non-empty, and zips that list against REVIEW.md's
rows for the same (table, column) in DOCUMENT order. Before writing anything it
re-checks that the data's current text still equals the doc's Original --
zero-trust, even though check_originals.py already said so.

Each row is edited on its own line with a targeted regex, not by round-tripping
the JSON -- data.js's "one row per line" convention is what makes `git diff`
useful on this file, and a full re-serialize would reformat every row and bury
the real change in noise.

Usage:
    python apply_review.py                  # dry run -- report only
    python apply_review.py --apply           # write static/data.js
    python apply_review.py --apply --exclude misc_gear:Lick,misc_gear:Rage
                                              # apply everything except named rows
"""

import argparse
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import verify as V  # noqa: E402

TABLE_OPEN_RE = re.compile(r'^"([a-z_]+)":\[\s*$')


def find_table_rows(lines, table):
    """Line indices (0-based) holding this table's row objects, in file order."""
    start = None
    for i, line in enumerate(lines):
        m = TABLE_OPEN_RE.match(line)
        if m and m.group(1) == table:
            start = i + 1
            break
    if start is None:
        raise SystemExit("table not found in data.js: %r" % table)
    idxs = []
    for i in range(start, len(lines)):
        s = lines[i].strip()
        if s in ("],", "]"):
            return idxs
        if not s.startswith("{"):
            raise SystemExit("unexpected line %d while reading %r: %r"
                             % (i + 1, table, lines[i][:80]))
        idxs.append(i)
    raise SystemExit("closing ']' for %r not found" % table)


def cell_pattern(column):
    # The literal key delimiters ("Column": ) anchor this so a longer key that
    # happens to contain this one as a substring -- "Effect" inside
    # "ModeEffect" -- can never match: the quote immediately before "Effect"
    # would have to be there, and in "ModeEffect" it isn't.
    return re.compile(r'"%s":"(?:[^"\\]|\\.)*"' % re.escape(column))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--review", default=os.path.join(HERE, "REVIEW.md"))
    ap.add_argument("--data", default=os.path.join(REPO, "static", "data.js"))
    ap.add_argument("--apply", action="store_true", help="write the file (default: dry run)")
    ap.add_argument("--exclude", default="",
                    help="comma-separated table:Row pairs to skip entirely, e.g. "
                         "misc_gear:Lick,misc_gear:Rage")
    args = ap.parse_args()
    excluded = set(x.strip() for x in args.exclude.split(",") if x.strip())

    doc_rows = V.read_rows(args.review)
    groups = {}
    for r in doc_rows:
        groups.setdefault((r["table"], r["column"]), []).append(r)

    text = io.open(args.data, encoding="utf-8").read()
    lines = text.split("\n")

    applied, unchanged, skipped, mismatches = [], [], [], []

    for (table, column), doc_group in groups.items():
        row_idxs = find_table_rows(lines, table)
        matched = []
        for i in row_idxs:
            raw = lines[i].rstrip(",").rstrip()
            try:
                row = json.loads(raw)
            except json.JSONDecodeError as e:
                raise SystemExit("line %d does not parse as JSON: %s" % (i + 1, e))
            if str(row.get(column, "") or "").strip():
                matched.append((i, row))
        if len(matched) != len(doc_group):
            raise SystemExit(
                "%s / %s: doc has %d non-empty rows, data.js has %d -- "
                "run check_originals.py, something has drifted"
                % (table, column, len(doc_group), len(matched)))

        for r, (i, row) in zip(doc_group, matched):
            key = "%s:%s" % (table, r["name"])
            current = str(row.get(column, "")).strip()
            if current != r["original"].strip():
                mismatches.append((table, column, r["name"], current, r["original"]))
                continue
            if key in excluded:
                skipped.append((table, column, r["name"]))
                continue
            proposed = r["proposed"].strip()
            if current == proposed:
                unchanged.append((table, column, r["name"]))
                continue
            pat = cell_pattern(column)
            m = pat.search(lines[i])
            if not m or json.loads(m.group()[len(column) + 3:]) != current:
                raise SystemExit(
                    "%s / %s / %s: could not locate the cell on line %d as expected"
                    % (table, column, r["name"], i + 1))
            new_cell = '"%s":%s' % (column, json.dumps(proposed, ensure_ascii=False))
            lines[i] = lines[i][:m.start()] + new_cell + lines[i][m.end():]
            applied.append((table, column, r["name"], current, proposed))

    print("%d cell(s) would change, %d already match, %d skipped (excluded), "
          "%d unchanged already" % (len(applied), 0, len(skipped), len(unchanged)))
    by_table = {}
    for t, c, n, *_ in applied:
        by_table[t] = by_table.get(t, 0) + 1
    for t in sorted(by_table):
        print("  %-28s %d" % (t, by_table[t]))
    if skipped:
        print("\nExcluded (left untouched):")
        for t, c, n in skipped:
            print("  %s / %s / %s" % (t, c, n))
    if mismatches:
        print("\n%d row(s) whose current data.js text no longer matches the doc's "
              "Original -- ABORTING, nothing written:" % len(mismatches))
        for t, c, n, cur, orig in mismatches[:10]:
            print("  %s / %s / %s" % (t, c, n))
            print("    data.js: %s" % cur[:100])
            print("    doc:     %s" % orig[:100])
        return 1

    if not args.apply:
        print("\n(dry run -- pass --apply to write %s)" % args.data)
        return 0

    io.open(args.data, "w", encoding="utf-8", newline="").write("\n".join(lines))
    print("\nwrote %s" % args.data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
