#!/usr/bin/env python3
"""Where the prose and the structured column disagree.

heritage_features and augments both carry real columns for the numbers their
Effect prose also states: heritage has Observation/Move/Dodge/Soak/Shadow/...,
augments have Strength/Body/Reaction/Impact Armor/Ballistic Armor. The engine
reads the COLUMN. The player reads the PROSE. When they disagree, the sheet is
right and the text is lying -- or the text is right and someone forgot the
column, in which case the bonus silently doesn't exist.

Neither is fixable by rewording alone, so these need to reach the review doc as
CHECK items rather than being quietly "cleaned up".

Usage:  python column_drift.py
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import probe as P

# column -> how the prose refers to it
HERITAGE = {
    "Observation": r"Observation", "Recon": r"Recon\w*", "Dodge": r"dodge",
    "Shadow": r"Shadow|Stealth", "Athletics": r"Athletics", "Soak": r"Soak",
    "Sorcery": r"Sorcery", "Conjuring": r"Conjuring", "Channeling": r"Channeling",
    "AstralSenses": r"Astral Senses", "All": r"all tests",
    "Ballistic Armor": r"Ballistic", "Impact Armor": r"Impact",
}
AUGMENT = {
    "Strength": r"Strength", "Body": r"Body", "Reaction": r"Reaction",
    "Intelligence": r"Intelligence", "Willpower": r"Willpower",
    "Charisma": r"Charisma", "Impact Armor": r"Impact", "Ballistic Armor": r"Ballistic",
}


def prose_number(text, word_re):
    """The number governing a mention of `word_re` -- the NEAREST one.

    Proximity matters more than any clever pattern here. "grants +2 to body and
    1 Impact armor" carries two numbers and only the closer one belongs to
    Impact; a pattern that scans leftwards without a distance limit happily
    reports 2 and invents a contradiction that isn't in the data.
    """
    hit = re.search(word_re, text, re.I)
    if not hit:
        return None
    numbers = [(m.start(), m.end(), int(m.group()))
               for m in re.finditer(r"[+-]?\d+", text)]
    if not numbers:
        return None
    best, best_gap = None, 10 ** 9
    for start, end, value in numbers:
        if end <= hit.start():
            gap = hit.start() - end          # number precedes the word
        elif start >= hit.end():
            gap = (start - hit.end()) + 3    # trailing numbers are weaker evidence
        else:
            continue
        if gap < best_gap and gap <= 24:
            best, best_gap = value, gap
    return best


def check(table, name_col, text_col, mapping):
    rows = P.load_bundle()["tables"][table]
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        text = str(row.get(text_col, "") or "").strip()
        if not text:
            continue
        name = str(row.get(name_col, ""))
        for column, word_re in mapping.items():
            raw = str(row.get(column, "") or "").strip()
            col_val = None
            if raw not in ("", "-"):
                try:
                    col_val = int(float(raw))
                except ValueError:
                    col_val = None
            mentioned = re.search(word_re, text, re.I)
            prose_val = prose_number(text, word_re) if mentioned else None
            if mentioned and col_val is None and prose_val:
                out.append((name, column, "prose only", prose_val, raw, text))
            elif col_val and not mentioned:
                out.append((name, column, "column only", None, raw, text))
            elif col_val and prose_val is not None and col_val != prose_val:
                out.append((name, column, "DISAGREE", prose_val, raw, text))
    return out


def main():
    for table, name_col, text_col, mapping in (
            ("heritage_features", "Name", "Effects", HERITAGE),
            ("augments", "Name", "Effect", AUGMENT)):
        print("=" * 78)
        print(table)
        print("=" * 78)
        rows = check(table, name_col, text_col, mapping)
        for kind in ("DISAGREE", "prose only", "column only"):
            group = [r for r in rows if r[2] == kind]
            if not group:
                continue
            print("\n-- %s (%d)\n" % (kind, len(group)))
            for name, column, _k, prose_val, raw, text in group:
                print("  %-28s %-16s prose=%-5s column=%-5s" %
                      (name[:28], column, prose_val, raw or "-"))
                print("      %s" % text[:130])
        print()


if __name__ == "__main__":
    main()
