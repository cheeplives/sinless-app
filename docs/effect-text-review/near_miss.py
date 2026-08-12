#!/usr/bin/env python3
"""Text that describes a mechanic the engine CAN read, but doesn't.

Two distinct failures live here and the doc should not conflate them:

  NEAR MISS   the column IS wired to a parser and the row talks about that
              mechanic, but the phrasing misses the pattern by a hair.
              "Ignore wound pen" is two characters short of /wound penalt/i.
              These are bugs a rewrite fixes for free.

  NOT WIRED   the phrasing is fine, but nothing hands this column to that
              parser. Rewriting cannot fix it; only rules.js can. Worth listing
              so nobody rewrites a row expecting it to start working.

Usage:  python near_miss.py
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import probe as P

# What a row is TALKING about, regardless of whether the parser catches it.
TOPICS = {
    "pool": re.compile(r"\b(Brawn|Finesse|Focus|Resolve)\b", re.I),
    "wound": re.compile(r"wound\s*pen|pain\s*pen|damage penalt", re.I),
    "sense": re.compile(r"\b(vision|sight|see|seeing|hear|hearing|dark|darkness"
                        r"|low.?light|thermal|thermograph|infrared|ultraviolet"
                        r"|echolocat|sonic|magnif)\w*", re.I),
    "cover": re.compile(r"\bcover\b", re.I),
    "initiative": re.compile(r"initiat", re.I),
    "etiquette": re.compile(r"etiquette", re.I),
    "movement": re.compile(r"\bmove\b|\bmovement\b|\bflight\b|\bfly\b", re.I),
    "recoil": re.compile(r"recoil", re.I),
}

# Which parser family a hit string belongs to.
def family(hit):
    if hit.startswith("pool"):
        return "pool"
    if hit.startswith("sense"):
        return "sense"
    if hit.startswith("etiquette"):
        return "etiquette"
    if hit.startswith("cover") or "cover note" in hit:
        return "cover"
    if "wound penalty" in hit:
        return "wound"
    if "initiative" in hit:
        return "initiative"
    if hit.startswith("movement"):
        return "movement"
    if "recoil" in hit:
        return "recoil"
    return None


def main():
    tables = P.load_bundle()["tables"]
    near, unwired = [], []
    for (table, column), parsers in P.WIRING.items():
        for row in tables.get(table, []):
            if not isinstance(row, dict):
                continue
            text = str(row.get(column, "") or "").strip()
            if not text:
                continue
            name = P.row_name(row)
            hits = P.probe_cell(table, column, name, text)
            families = {family(h) for h in hits}
            for topic, rx in TOPICS.items():
                if not rx.search(text) or topic in families:
                    continue
                wired = topic in parsers or (topic == "movement" and "martial" in parsers) \
                    or (topic == "recoil" and "martial" in parsers)
                entry = (table, column, name, topic, text)
                (near if wired else unwired).append(entry)

    print("=== NEAR MISSES -- column is wired, phrasing misses the pattern ===\n")
    for table, column, name, topic, text in near:
        print("%-18s %-28s [%s]\n    %s\n" % (table, name[:28], topic, text[:150]))
    print("\n=== NOT WIRED -- phrasing is fine, engine never sees this column ===\n")
    seen = set()
    for table, column, name, topic, text in unwired:
        key = (table, column, topic)
        if key in seen:
            continue
        seen.add(key)
        n = sum(1 for e in unwired if (e[0], e[1], e[3]) == key)
        print("%-18s %-12s [%-10s] %d row(s), e.g. %s" % (table, column, topic, n, name))
    print("\n%d near misses, %d unwired topic/column pairs" % (len(near), len(seen)))


if __name__ == "__main__":
    main()
