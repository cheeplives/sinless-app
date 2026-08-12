#!/usr/bin/env python3
"""Compare every column in static/data.js against the homebrew editor's fields.

A character stores names, and the engine reads columns off data rows. Add a
column to a table and the engine can use it immediately — but the homebrew
editor builds its form from a hand-written field list in HOMEBREW_CONFIG, so a
new column is invisible there until someone adds it. Homebrew authors then have
a row shape they cannot fill in, and the omission is silent.

This reports the gap. Run it after touching static/data.js.

Usage:
    python check_homebrew_columns.py [--repo PATH] [--json] [--table NAME]

Exit status is 1 when a data column has no editor field, so it can gate a hook.
"""

import argparse
import io
import json
import os
import re
import sys

# Columns the editor deliberately never shows.
#   Custom  — the marker homebrew.js stamps on rows the user created.
#   Requires/Mount* etc. ARE shown; they're listed in HOMEBREW_CONFIG already.
IGNORED_COLUMNS = {"Custom"}


def load_tables(data_js_path):
    """The `tables` object out of static/data.js.

    data.js is a JSON literal assigned to a const, so the value can be sliced
    out and parsed directly rather than executed.
    """
    src = io.open(data_js_path, encoding="utf-8").read()
    start = src.index("{", src.index("DATA_BUNDLE"))
    end = src.rindex("}")
    bundle = json.loads(src[start:end + 1])
    return bundle.get("tables", {})


def data_columns(rows):
    """Column names a table actually uses, in first-seen order.

    Union across rows, not just the first one: a column added to a handful of
    rows (Integrated Smart, Oneshot) is exactly the case this exists to catch,
    and reading row 0 alone would miss it.
    """
    seen = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in row:
            if key not in seen and key not in IGNORED_COLUMNS:
                seen.append(key)
    return seen


def editor_fields(homebrew_js_path):
    """{table: [field keys]} from HOMEBREW_CONFIG.

    Read with a regex rather than a JS parser because the config holds arrow
    functions (`datalist: () => hbDistinct(...)`) that no JSON reader will take.
    Field keys themselves are plain string literals, which makes them safe to
    scrape; the surrounding config is only used to find table boundaries.
    """
    src = io.open(homebrew_js_path, encoding="utf-8").read()
    start = src.index("const HOMEBREW_CONFIG")
    # Table entries are two-space-indented `name: { label: "...", ...`.
    starts = [(m.start(), m.group(1)) for m in
              re.finditer(r"^  (\w+): \{ label:", src[start:], re.M)]
    out = {}
    for i, (offset, table) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(src) - start
        block = src[start + offset:start + end]
        out[table] = re.findall(r"\{\s*key:\s*[\"']([^\"']+)[\"']", block)
    return out


def compare(tables, fields):
    report = {"missing": {}, "extra": {}, "uneditable": []}
    for table, rows in sorted(tables.items()):
        if not isinstance(rows, list) or not rows:
            continue
        cols = data_columns(rows)
        if table not in fields:
            # Plenty of tables are reference data with no editor by design
            # (priorities, attribute_costs). Listed, never failed on.
            report["uneditable"].append(table)
            continue
        declared = set(fields[table])
        missing = [c for c in cols if c not in declared]
        extra = [f for f in fields[table] if f not in cols]
        if missing:
            report["missing"][table] = missing
        if extra:
            report["extra"][table] = extra
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="repo root (default: cwd)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--table", help="check one table only")
    args = ap.parse_args()

    data_js = os.path.join(args.repo, "static", "data.js")
    homebrew_js = os.path.join(args.repo, "static", "homebrew.js")
    for path in (data_js, homebrew_js):
        if not os.path.exists(path):
            sys.stderr.write("not found: %s (wrong --repo?)\n" % path)
            return 2

    tables = load_tables(data_js)
    fields = editor_fields(homebrew_js)
    if args.table:
        tables = {k: v for k, v in tables.items() if k == args.table}
        if not tables:
            sys.stderr.write("no such table: %s\n" % args.table)
            return 2
    report = compare(tables, fields)

    if args.json:
        print(json.dumps(report, indent=2))
        return 1 if report["missing"] else 0

    if report["missing"]:
        print("Columns in data.js with no field in the homebrew editor:\n")
        for table, cols in sorted(report["missing"].items()):
            print("  %s" % table)
            for col in cols:
                n = sum(1 for r in tables[table] if isinstance(r, dict) and r.get(col))
                print("      %-24s used by %d row(s)" % (col, n))
        print("\nAdd each to HOMEBREW_CONFIG.%s.fields in static/homebrew.js." %
              sorted(report["missing"])[0])
    else:
        print("Every data column has an editor field.")

    if report["extra"]:
        print("\nEditor fields no data row uses (usually fine — an author can be"
              "\nthe first to set one — but check for a typo in the key):\n")
        for table, extra in sorted(report["extra"].items()):
            print("  %-28s %s" % (table, ", ".join(extra)))

    if report["uneditable"]:
        print("\nTables with no homebrew editor (by design for reference data):")
        print("  " + ", ".join(report["uneditable"]))

    return 1 if report["missing"] else 0


if __name__ == "__main__":
    sys.exit(main())
