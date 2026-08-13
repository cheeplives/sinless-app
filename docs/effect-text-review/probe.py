#!/usr/bin/env python3
"""Which rules.js parsers currently fire on each prose cell in data.js.

Every pattern below is transcribed from static/rules.js with the line number it
came from, so the "does the engine read this?" answer in the review doc is
observed rather than guessed. Transcription, not execution -- rules.js can't run
here (no Node) -- so treat a surprising result as a reason to check the source.

The WIRING map matters as much as the patterns: a parser only ever sees the
table/column it is actually handed. weapon_mods.Effect reaches the etiquette
parser and nothing else, so "+1 Recoil Capacity" there is display text no matter
how machine-readable it looks.

Usage:  python probe.py [--json] [--table NAME]
"""
import argparse
import io
import json
import os
import re

REPO = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".."))

POOL_NAMES = ["Brawn", "Finesse", "Focus", "Resolve"]          # rules.js:93
ETIQUETTES = ["Aristocratic", "Civic", "Corporate", "Criminal",  # rules.js:120
              "Military", "Street", "Wasteland"]

# --- transcribed patterns ----------------------------------------------------

# rules.js:4104 POOL_DICE_RE  (derivePoolEffects -> conditional pool toggles)
_ALT = "|".join(POOL_NAMES)
_LIST = r"(?:%s)(?:\s*(?:[/,&]|,?\s*and)\s*(?:%s))*" % (_ALT, _ALT)
POOL_DICE_RE = re.compile(
    r"([+\u2212-]\s*\d+)\s*(?:d\b|dice)?\s*(?:in\s+)?(?:bonus\s+)?(?:dice\s+)?"
    r"(?:to\s+)?(?:the\s+|their\s+)?(%s)" % _LIST, re.I)

# rules.js:2654 SENSE_CAPABILITIES (deriveSenseNotes -> Enhanced Senses banner)
SENSE_CAPABILITIES = [
    ("Thermographic vision", r"\bthermograph"),
    ("Infrared vision", r"\binfrared\b"),
    ("Ultraviolet vision", r"\bultraviolet\b"),
    ("Echolocation", r"\becholocat"),
    ("Vision magnification", r"\bvision mag|magnif\w*\s+vision"),
    ("Selective hearing", r"sound filtering"),
    ("Sonic protection", r"\bsonic\b"),
    ("Sees in darkness / low light",
     r"ignore[^.]*\b(?:low.?light|darkness|dark)\b|treat darkness"
     r"|\bsee better\b[^.]*\bdark|\bcan see\b[^.]*\bdark"
     r"|\bdetect[^.]*\b(?:darkness|dark)\b"),
]
SENSE_CAPABILITIES = [(l, re.compile(p, re.I)) for l, p in SENSE_CAPABILITIES]

# rules.js:4209-4219 martialArtStatMods
MA_PATTERNS = [
    ("dodge dice", re.compile(r"([+-]?\d+)\s*d\b[^.]*?\bdodge\b", re.I)),
    ("soak dice", re.compile(r"([+-]?\d+)\s*d\b[^.]*?\bsoak\b", re.I)),
    ("movement", re.compile(r"([+-]?\d+)\s*m\b[^.]*?mov", re.I)),
    ("recoil ignored", re.compile(r"ignore\s+recoil", re.I)),
    ("unarmed damage", re.compile(r"unarmed[^.]*?str\s*\+\s*(\d+)", re.I)),
    ("spurs damage", re.compile(r"spurs?[^.]*?(\d+)\s*\+\s*str", re.I)),
]
MA_DODGE_VETO = re.compile(r"\b(vs|if)\b", re.I)       # rules.js:4210
COVER_RE = re.compile(r"\b(low|high|full)\s+cover\b", re.I)   # rules.js:4290

# rules.js:2611-2621 droneCombatBonuses
DRONE_INIT_RE = re.compile(r"([+-]?\d+)\s*d?\s*(?:to\s+)?Initiative", re.I)
DRONE_ROUTES = [("dodge note", re.compile(r"dodge", re.I)),
                ("cover note", re.compile(r"cover", re.I)),
                ("vision note", re.compile(r"vision", re.I))]

# rules.js:2570-2576 droneSkillDice
DRONE_NUM_RE = re.compile(r"([+-]?\d+)\s*d?")

# rules.js:4985 / 4996
WOUND_REMOVE = (re.compile(r"wound penalt", re.I),
                re.compile(r"(remove|ignore|negat|nullif|zero|no\b)", re.I))
WOUND_DOUBLE = (re.compile(r"doubl", re.I),
                re.compile(r"(wound|pain)[- ]?(based )?penalt", re.I))

INIT_SCAN = "initiat"                                   # rules.js:4067
NO_BONUS_RE = re.compile(r"^no bonus$", re.I)           # rules.js:3234


def parse_pool_dice(text):
    """rules.js:4115 -- first clause per pool wins."""
    out = {}
    for m in POOL_DICE_RE.finditer(text or ""):
        try:
            n = int(m.group(1).replace("\u2212", "-").replace(" ", ""))
        except ValueError:
            continue
        if not n:
            continue
        for raw in re.split(r"[/,&]|\band\b", m.group(2)):
            pool = raw.strip()
            if pool in POOL_NAMES and pool not in out:
                out[pool] = n
    return out or None


def sense_clauses(text):
    """rules.js:2677 -- split on sentence ends, strip a leading 'grants'."""
    parts = re.split(r"(?<=[.;])\s+", str(text or ""))
    return [p.strip() for p in
            (re.sub(r"^grants\s+", "", q.strip(), flags=re.I) for q in parts) if p.strip()]


def sense_capability(source, clause):
    """rules.js:2668 -- tested against '<row name> <clause>'."""
    probe = source + " " + clause
    for label, rx in SENSE_CAPABILITIES:
        if rx.search(probe):
            return label
    return None


def parse_etiquette(text):
    """rules.js:3917 -- a number governs names after it, until the next number."""
    s = str(text or "")
    if not re.search(r"etiquette", s, re.I):
        return []
    marks = [(int(m.group()), m.start(), m.end())
             for m in re.finditer(r"[+-]?\d+", s)]
    out = []
    for i, (n, _f, to) in enumerate(marks):
        if not n:
            continue
        span = s[to:marks[i + 1][1] if i + 1 < len(marks) else len(s)]
        stop = re.search(r"[.;]", span)
        if stop:
            span = span[:stop.start()]
        names = set()
        if re.search(r"\ball\b", span, re.I):
            names |= set(ETIQUETTES)
        else:
            for word in re.findall(r"[A-Za-z]+", span):
                if len(word) < 3:
                    continue
                for e in ETIQUETTES:
                    if e.lower().startswith(word.lower()):
                        names.add(e)
        for e in sorted(names):
            out.append((e, n))
    return out


# --- wiring: which parser is handed which table/column ------------------------
# The second element is what calls it, for the review doc's provenance column.
WIRING = {
    ("heritage_features", "Effects"): ["pool", "sense", "initiative", "wound"],
    ("augments", "Effect"): ["pool", "sense", "initiative", "etiquette", "wound"],
    ("augments", "Description"): ["wound"],
    ("misc_gear", "Effect"): ["pool", "sense", "etiquette"],
    ("misc_gear", "Notes"): ["etiquette"],
    ("amp_powers", "Effect"): ["pool", "initiative"],
    ("spells", "Effect"): ["pool"],
    ("martial_arts", "Effect"): ["martial", "cover", "initiative", "wound"],
    ("drones", "Effect"): ["drone"],
    ("weapon_mods", "Effect"): ["etiquette"],
    ("armor_materials", "Effect"): ["etiquette", "nobonus"],
    ("armor_extras", "Effects"): ["etiquette", "nobonus"],
    # Everything else is display-only as far as the engine is concerned.
}
DISPLAY_ONLY = [
    ("armor_extras", "Notes"), ("programs", "Effect"), ("programs", "Description"),
    ("rituals", "Effect"), ("rituals", "Description"), ("spells", "Description"),
    ("amp_powers", "Description"), ("weapons", "Notes"), ("deck_mods", "Effect"),
    ("rig_mods", "Effect"), ("hack_actions", "Notes"),
    ("drone_ballistic_weapons", "Effect"), ("drone_ballistic_weapons", "ModeEffect"),
    ("drone_energy_weapons", "ModeEffect"), ("drone_mods", "ModeEffect"),
    ("vehicle_ballistic_weapons", "Effect"), ("vehicle_ballistic_weapons", "ModeEffect"),
    ("vehicle_energy_weapons", "ModeEffect"), ("vehicle_mods", "ModeEffect"),
    ("speaker_spirits", "Bound Services"), ("speaker_spirits", "Attacks"),
    ("speaker_spirits", "Condition"), ("augments", "Ban"), ("heritage_features", "Ban"),
    ("augments", "Skill Note"),
]

NAME_COLS = ["Name", "Augment", "Program", "Spell", "Weapon", "Modification",
             "Martial Art", "Style", "Item", "Drone", "Vehicle", "Power",
             "Ritual", "Deck Mod", "Rig Mod", "Material", "Extra", "Action",
             "Drone Ballistic Weapon", "Vehicle Ballistic Weapon",
             "Drone Energy Weapon", "Vehicle Energy Weapon",
             "Drone Mod", "Vehicle Mod", "Spirit"]


def row_name(row):
    for k in NAME_COLS:
        if k in row and str(row[k]).strip():
            return str(row[k])
    return "/".join(str(v) for v in list(row.values())[:2])


def probe_cell(table, column, name, text):
    """Every parser hit on one cell, as short strings for the review table."""
    hits = []
    parsers = WIRING.get((table, column), [])
    if "pool" in parsers:
        pools = parse_pool_dice(text)
        if pools:
            # Sorted into POOL_NAMES order: parsePoolDice returns a dict, so its
            # insertion order follows the sentence, not the mechanics. Comparing
            # unsorted strings makes "+2 Resolve/Brawn" and "+2 Brawn/Resolve"
            # look like a behaviour change when nothing has changed at all.
            hits.append("pool " + ", ".join(
                "%s%+d" % (p, pools[p]) for p in POOL_NAMES if p in pools))
    if "sense" in parsers:
        for clause in sense_clauses(text):
            cap = sense_capability(name, clause)
            if cap and ("sense: " + cap) not in hits:
                hits.append("sense: " + cap)
    if "etiquette" in parsers:
        for e, n in parse_etiquette(text):
            hits.append("etiquette %s%+d" % (e, n))
    if "initiative" in parsers and INIT_SCAN in text.lower():
        hits.append("initiative note")
    if "wound" in parsers:
        if WOUND_REMOVE[0].search(text) and WOUND_REMOVE[1].search(text):
            hits.append("removes wound penalty")
        if WOUND_DOUBLE[0].search(text) and WOUND_DOUBLE[1].search(text):
            hits.append("doubles wound penalty")
    if "martial" in parsers:
        for label, rx in MA_PATTERNS:
            m = rx.search(text)
            if not m:
                continue
            if label == "dodge dice" and MA_DODGE_VETO.search(text):
                hits.append("dodge dice VETOED (vs/if)")
                continue
            val = m.group(1) if m.groups() else ""
            hits.append(("%s %s" % (label, val)).strip())
    if "cover" in parsers:
        m = COVER_RE.search(text)
        if m:
            hits.append("cover: %s" % m.group(1).lower())
    if "drone" in parsers:
        for clause in re.split(r"[,.;]", text):
            c = clause.strip()
            if not c:
                continue
            init = DRONE_INIT_RE.search(c)
            if init:
                hits.append("drone initiative %s" % init.group(1))
                continue
            routed = False
            for label, rx in DRONE_ROUTES:
                if rx.search(c):
                    hits.append("drone %s" % label)
                    routed = True
                    break
            if routed:
                continue
        # droneSkillDice runs over the same clauses independently (rules.js:2569)
        for clause in re.split(r"[,.;]", text):
            m = DRONE_NUM_RE.search(clause)
            if not m or not m.group(1):
                continue
            try:
                n = int(m.group(1))
            except ValueError:
                continue
            if not n:
                continue
            for skill in SKILLS_CACHE:
                for alias in ALIASES_CACHE.get(skill, [skill]):
                    if re.search(r"\b%s\b" % re.escape(alias), clause, re.I):
                        hits.append("drone skill %s%+d" % (skill, n))
                        break
    if "nobonus" in parsers and text.strip() and not NO_BONUS_RE.match(text.strip()):
        pass
    return hits


def load_bundle():
    src = io.open(os.path.join(REPO, "static", "data.js"), encoding="utf-8").read()
    return json.loads(src[src.index("{", src.index("DATA_BUNDLE")):src.rindex("}") + 1])


def load_skill_aliases():
    """SKILLS keys and SKILL_ALIASES out of rules.js, for the drone probe."""
    src = io.open(os.path.join(REPO, "static", "rules.js"), encoding="utf-8").read()
    block = src[src.index("const SKILLS = {"):]
    block = block[:block.index("\n};")]
    skills = re.findall(r'^\s*"([^"]+)":\s*\[', block, re.M)
    ab = src[src.index("const SKILL_ALIASES = {"):]
    ab = ab[:ab.index("\n};")]
    aliases = {}
    for m in re.finditer(r'"([^"]+)":\s*\[([^\]]*)\]', ab):
        aliases[m.group(1)] = re.findall(r'"([^"]+)"', m.group(2))
    return skills, aliases


SKILLS_CACHE, ALIASES_CACHE = load_skill_aliases()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--table")
    ap.add_argument("--only-hits", action="store_true")
    args = ap.parse_args()

    tables = load_bundle()["tables"]
    results = []
    for (table, column) in list(WIRING) + DISPLAY_ONLY:
        if args.table and table != args.table:
            continue
        for row in tables.get(table, []):
            if not isinstance(row, dict):
                continue
            text = str(row.get(column, "") or "").strip()
            if not text:
                continue
            name = row_name(row)
            hits = probe_cell(table, column, name, text)
            if args.only_hits and not hits:
                continue
            results.append({"table": table, "column": column, "name": name,
                            "text": text, "hits": hits,
                            "engine_read": bool(WIRING.get((table, column)))})

    if args.json:
        print(json.dumps(results, indent=1, ensure_ascii=False))
        return
    for r in results:
        flag = "*" if r["hits"] else " "
        print("%s %-24s %-14s %-34s %s" % (flag, r["table"], r["column"],
                                           r["name"][:34], "; ".join(r["hits"])))
    print("\n%d cells, %d with a parser hit" % (len(results),
                                                sum(1 for r in results if r["hits"])))


if __name__ == "__main__":
    main()
