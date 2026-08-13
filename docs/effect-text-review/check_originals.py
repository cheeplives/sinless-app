#!/usr/bin/env python3
"""Every Original cell in REVIEW.md must still match static/data.js exactly.

The Original column is the review's factual record of what the data says today.
Everything else rests on it: the Proposed text is judged against it, and verify.py
diffs parser hits between the two. If an Original drifts, the document quietly
starts reviewing something that doesn't exist, and a real behaviour change can
hide inside the mismatch.

This is easy to break by accident. A row whose Original and Proposed are
identical -- an unchanged row -- has the same text twice on the line, so a
naive search-and-replace aimed at the Proposed cell can land on the Original
instead. That is exactly how the Aztechnologies Dazzleray row got swapped.

Exit status is 1 on any mismatch.

Usage:  python check_originals.py [--doc PATH]
"""

import argparse
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import verify as V  # noqa: E402

NAME_COLS = ["Name", "Item", "Weapon", "Modification", "Drone", "Vehicle",
             "Style", "Material", "Extra", "Action", "Spirit", "Rig Type",
             "Drone Ballistic Weapon", "Vehicle Ballistic Weapon",
             "Drone Energy Weapon", "Vehicle Energy Weapon",
             "Drone Mod", "Vehicle Mod", "Deck Mod",
             "Rig Mod", "Martial Art"]


def load_tables():
    src = io.open(os.path.join(REPO, "static", "data.js"), encoding="utf-8").read()
    return json.loads(
        src[src.index("{", src.index("DATA_BUNDLE")):src.rindex("}") + 1])["tables"]


def row_name(row):
    for k in NAME_COLS:
        if k in row and str(row[k]).strip():
            return str(row[k])
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", default=os.path.join(HERE, "REVIEW.md"))
    args = ap.parse_args()

    tables = load_tables()
    rows = V.read_rows(args.doc)
    if not rows:
        sys.stderr.write("no rows read from %s\n" % args.doc)
        return 2

    mismatches, unfound = [], []
    for r in rows:
        table = tables.get(r["table"])
        if table is None:
            unfound.append((r, "no such table"))
            continue
        # Martial arts repeat a style name per level, so match on the text too.
        hits = [row for row in table
                if isinstance(row, dict) and row_name(row) == r["name"]]
        if not hits:
            unfound.append((r, "no row named %r" % r["name"]))
            continue
        want = r["original"].strip()
        if any(str(row.get(r["column"], "") or "").strip() == want for row in hits):
            continue
        mismatches.append((r, [str(row.get(r["column"], "") or "").strip()
                               for row in hits]))

    # Name matching alone is not enough. A martial-art style names six rows (one
    # per level), so `any()` above would accept an Original that had been
    # overwritten with a DIFFERENT level's text. Comparing the whole (table,
    # column) as a multiset closes that: it does not care about names at all,
    # only that the doc holds exactly the values the data holds.
    doc_cells, data_cells = {}, {}
    for r in rows:
        doc_cells.setdefault((r["table"], r["column"]), []).append(r["original"].strip())
    for (table, column) in doc_cells:
        data_cells[(table, column)] = sorted(
            str(row.get(column, "") or "").strip()
            for row in tables.get(table, [])
            if isinstance(row, dict) and str(row.get(column, "") or "").strip())
    setwise = []
    for key, got in doc_cells.items():
        want = data_cells[key]
        if sorted(got) != want:
            missing = [v for v in want if v not in got]
            extra = [v for v in got if v not in want]
            setwise.append((key, missing, extra))

    # …and a multiset is still not enough, because swapping two Originals inside
    # one column leaves it unchanged. Two Gun-Kata levels trading text passes
    # both checks above and is exactly the corruption they were meant to stop.
    # The doc is generated in table order, so position is the real invariant.
    ordered = {}
    for (table, column) in doc_cells:
        ordered[(table, column)] = [
            str(row.get(column, "") or "").strip()
            for row in tables.get(table, [])
            if isinstance(row, dict) and str(row.get(column, "") or "").strip()]
    positional = []
    for key, got in doc_cells.items():
        want = ordered[key]
        if len(got) != len(want):
            continue                      # length is already reported as setwise
        for i, (g, w) in enumerate(zip(got, want)):
            if g != w:
                positional.append((key, i, g, w))

    print("%s\n  %d rows checked against static/data.js" % (
        os.path.basename(args.doc), len(rows)))
    if unfound:
        print("\n  %d row(s) could not be located in the data (renamed? removed?):"
              % len(unfound))
        for r, why in unfound[:15]:
            print("    %-22s %-16s %s" % (r["table"], r["name"][:16], why))
    if mismatches:
        print("\n  %d ORIGINAL cell(s) no longer match the data:\n" % len(mismatches))
        for r, actual in mismatches:
            print("    %s / %s / %s" % (r["table"], r["name"], r["column"]))
            print("      doc:  %s" % r["original"])
            for a in actual:
                print("      data: %s" % a)
        return 1
    if setwise:
        print("\n  %d table/column(s) whose Originals are not the data's values:\n"
              % len(setwise))
        for (table, column), missing, extra in setwise:
            print("    %s / %s" % (table, column))
            for v in missing[:6]:
                print("      in data, not in doc:  %s" % v[:100])
            for v in extra[:6]:
                print("      in doc, not in data:  %s" % v[:100])
        return 1
    if positional:
        print("\n  %d Original(s) in the wrong position — the values are all present,"
              "\n  so only order gives this away (two rows swapped):\n" % len(positional))
        for (table, column), i, got, want in positional[:12]:
            print("    %s / %s  row %d" % (table, column, i + 1))
            print("      doc:  %s" % got[:100])
            print("      data: %s" % want[:100])
        return 1
    if not unfound:
        print("\n  Every Original matches the data exactly — by name, as a whole-column")
        print("  multiset, and in order. The last of those is what covers the 24")
        print("  martial-art rows whose style name repeats across six levels.")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
