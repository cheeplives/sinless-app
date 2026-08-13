#!/usr/bin/env python3
"""Prose that repeats a number the row already carries in a column.

`column_drift.py` asks whether prose and column DISAGREE. This asks the quieter
question: do they agree so exactly that the sentence is a copy? Those are the
rows the style guide wants reworded to name the stat and let the column hold the
value, because a number stated twice can only ever stay right by luck.

It was written after two rows slipped through the main pass -- `rig_mods` Bonus
Link ("+1 Link", column `Link` = 1) and `heritage_features` Rat ("+1 to all
tests", column `All` = 1). Both were missed for the same reason: the sweep that
found this pattern in augments knew about attribute and armor columns and had
never been pointed at `Link` or `All`. So this one takes the column names from
the data itself rather than from a list someone has to remember to update.

By default it reads the PROPOSED text out of REVIEW.md, because that is the
text being asked about: the originals are full of these echoes and removing them
is the whole point of the pass. Pass --data to scan static/data.js instead and
see what the pass started with.

Usage:  python column_echo.py [--table NAME] [--data]
"""

import argparse
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))

# Columns that are prose, not values -- never treat these as a number source.
TEXT_COLS = {"Effect", "Effects", "Description", "Notes", "ModeEffect",
             "Skill Bonus", "Skill Note", "Name", "Item", "Ban", "Cores"}

# What the prose might call a column. The column name itself is always tried.
SYNONYMS = {
    "All": ["all tests", "all rolls"],
    "Link": ["link", "links"],
    "Hardening": ["hardening", "base hardening"],
    "Ballistic Armor": ["ballistic armor", "ballistic armour", "b armor"],
    "Impact Armor": ["impact armor", "impact armour", "i armor"],
    "Bonus Dice": ["bonus dice"],
    "Move": ["movement", "move"],
    "Soak": ["soak"],
    "Dodge": ["dodge"],
    "Observation": ["observation"],
    "Recon": ["recon", "reconnaissance"],
    "Shadow": ["shadow"],
    "Athletics": ["athletics"],
    "STR": ["strength"], "BOD": ["body"], "REA": ["reaction"],
    "INT": ["intelligence"], "WILL": ["willpower"], "CHA": ["charisma"],
}


def load_tables():
    src = io.open(os.path.join(REPO, "static", "data.js"), encoding="utf-8").read()
    return json.loads(
        src[src.index("{", src.index("DATA_BUNDLE")):src.rindex("}") + 1])["tables"]


def as_number(v):
    m = re.match(r"^\s*([+\-]?\d+(?:\.\d+)?)\s*$", str(v or ""))
    return float(m.group(1)) if m else None


def echoes(text, label, value):
    """Does `text` state `value` right next to something called `label`?

    Deliberately narrow: the number has to sit within a few characters of the
    word, on either side, so "grants +2 to Body and 1 Impact armor" cannot pair
    the +2 with Impact. That mistake produced six phantom findings once already.
    """
    pat = re.compile(r"([+\-−]?\d+(?:\.\d+)?)\s*(?:d\b|dice|points? of)?\s*"
                     r"(?:to\s+|in\s+)?" + re.escape(label) + r"\b"
                     r"|" + re.escape(label) + r"\b\s*(?:of\s+|:\s*)?"
                     r"([+\-−]?\d+(?:\.\d+)?)", re.I)
    for m in pat.finditer(text):
        raw = m.group(1) or m.group(2)
        n = as_number(raw.replace("−", "-"))
        if n is not None and abs(n) == abs(value):
            return m.group(0).strip()
    return None


def proposed_index(path):
    """(table, name, column) -> proposed text, from REVIEW.md."""
    sys.path.insert(0, HERE)
    import verify as V
    out = {}
    for r in V.read_rows(path):
        out[(r["table"], r["name"], r["column"])] = r["proposed"].strip()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table")
    ap.add_argument("--data", action="store_true",
                    help="scan static/data.js instead of REVIEW.md's Proposed")
    ap.add_argument("--doc", default=os.path.join(HERE, "REVIEW.md"))
    args = ap.parse_args()

    tables = load_tables()
    prop = {} if args.data else proposed_index(args.doc)
    hits = []
    for tname, rows in sorted(tables.items()):
        if args.table and tname != args.table:
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = next((str(row[k]) for k in ("Name", "Item", "Rig Mod", "Drone Mod",
                                               "Vehicle Mod", "Deck Mod", "Modification",
                                               "Material", "Weapon", "Drone", "Vehicle",
                                               "Extra", "Style", "Spirit", "Action")
                         if k in row and str(row[k]).strip()), "?")
            for tcol in ("Effect", "Effects", "ModeEffect"):
                text = str(row.get(tcol, "") or "").strip()
                if not text:
                    continue
                if not args.data:
                    # Judge the rewrite, not the row it replaces. A row absent
                    # from the doc is one the pass never touched, so its
                    # original text is still the honest thing to scan.
                    text = prop.get((tname, name, tcol), text)
                for col, val in row.items():
                    if col in TEXT_COLS:
                        continue
                    value = as_number(val)
                    if value is None or value == 0:
                        continue
                    for label in [col] + SYNONYMS.get(col, []):
                        found = echoes(text, label, value)
                        if found:
                            hits.append((tname, name, tcol, col, val, found, text))
                            break

    print("%d prose cell(s) restate a number their own row already carries\n"
          % len(hits))
    for tname, name, tcol, col, val, found, text in hits:
        print("  %s / %s" % (tname, name))
        print("    column   %s = %s" % (col, val))
        print("    %-8s %s" % (tcol, text[:110]))
        print("    echo     %r\n" % found)
    return 0


if __name__ == "__main__":
    sys.exit(main())
