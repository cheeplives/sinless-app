#!/usr/bin/env python3
"""Re-run the rules.js parser probe over every PROPOSED rewrite in REVIEW.md.

The review is only trustworthy if a row claiming to be a formatting change
really is one. This reads every table in REVIEW.md, runs the transcribed
rules.js patterns over both the Original and the Proposed text, and diffs:

  LOST    a parser hit the original produced and the rewrite does not
          -- a silent behaviour change, the thing this exists to catch
  GAINED  a hit the rewrite creates that the original never had
          -- sometimes the point (Lick, Rage), but it has to be declared

A change is acceptable only when the row's Notes column declares it (NEW
BEHAVIOUR / CHECK / UNCLEAR). Anything else is a rewrite that would quietly
alter a character sheet, and the exit status is 1 so this can gate a hook.

Run it after editing REVIEW.md -- accepting a row, tweaking a proposed string,
adding a row -- and before copying any of it into static/data.js.

Usage:
    python verify.py [--doc PATH] [--verbose]
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import probe as P

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DOC = os.path.join(HERE, "REVIEW.md")

# Section headings look like "### augments — Effect". Two-to-four hashes so the
# file can be re-nested without breaking this.
HEADING_RE = re.compile(r"^#{2,4}\s+(\w+)\s+[-–—]+\s+(.+?)\s*$")

# A row may change what the engine sees only if it says exactly that.
# Deliberately just this one phrase: CHECK and UNCLEAR are flagged for all sorts
# of unrelated reasons, and accepting them here would let a row carrying one for
# a wording question quietly excuse a real parser change too.
DECLARED = ("NEW BEHAVIOUR",)


def split_row(line):
    """Cells of a markdown table row, honouring \\| escapes."""
    line = line.strip()
    if not line.startswith("|"):
        return None
    parts = re.split(r"(?<!\\)\|", line)[1:-1]
    return [p.strip().replace("\\|", "|") for p in parts]


def read_rows(path):
    """Every numbered row under a '<table> — <column>' heading.

    Tables in the front matter have no such heading and no leading row number,
    so they're skipped without needing to be listed here.
    """
    table = column = None
    rows = []
    for lineno, line in enumerate(open(path, encoding="utf-8"), 1):
        h = HEADING_RE.match(line)
        if h:
            table, column = h.group(1), h.group(2)
            continue
        cells = split_row(line)
        if not cells or len(cells) < 5 or not cells[0].strip().isdigit():
            continue
        if table is None:
            continue
        rows.append({"line": lineno, "table": table, "column": column,
                     "name": cells[1], "original": cells[2], "proposed": cells[3],
                     "notes": cells[5] if len(cells) > 5 else ""})
    return rows


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--doc", default=DEFAULT_DOC, help="review file (default: REVIEW.md)")
    ap.add_argument("--verbose", action="store_true",
                    help="also list rows whose wording is unchanged")
    args = ap.parse_args()

    if not os.path.exists(args.doc):
        sys.stderr.write("not found: %s\n" % args.doc)
        return 2

    rows = read_rows(args.doc)
    if not rows:
        sys.stderr.write("no table rows found in %s -- has the format changed?\n"
                         % args.doc)
        return 2

    problems, reworded, tables = [], 0, {}
    for r in rows:
        tables.setdefault(r["table"], 0)
        tables[r["table"]] += 1
        if r["original"].strip() != r["proposed"].strip():
            reworded += 1
        before = set(P.probe_cell(r["table"], r["column"], r["name"], r["original"]))
        after = set(P.probe_cell(r["table"], r["column"], r["name"], r["proposed"]))
        if before == after:
            continue
        declared = any(d in r["notes"].upper() for d in DECLARED)
        for hit in sorted(before - after):
            problems.append(("LOST", declared, r, hit))
        for hit in sorted(after - before):
            problems.append(("GAINED", declared, r, hit))

    print("%s" % os.path.basename(args.doc))
    print("  %d rows across %d tables, %d reworded"
          % (len(rows), len(tables), reworded))
    if args.verbose:
        for table in sorted(tables):
            print("    %-28s %d" % (table, tables[table]))

    if problems:
        print("\n%-7s %-5s %-22s %-28s %s"
              % ("change", "decl", "table", "row", "parser hit"))
        for kind, declared, r, hit in problems:
            print("%-7s %-5s %-22s %-28s %s"
                  % (kind, "yes" if declared else "NO",
                     r["table"], r["name"][:28], hit))

    undeclared = [p for p in problems if not p[1]]
    if undeclared:
        print("\n%d UNDECLARED parser change(s). Each one silently alters a "
              "character sheet." % len(undeclared))
        print("Either restore the wording the parser needs, or add NEW BEHAVIOUR "
              "to that row's\nNotes column to say the change is intended.")
        return 1

    declared_changes = len(problems)
    if declared_changes:
        print("\nNo undeclared parser changes (%d declared)." % declared_changes)
    else:
        print("\nNo parser changes at all -- every rewrite is formatting only.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
