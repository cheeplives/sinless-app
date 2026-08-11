/**
 * md-import.js — turning a Markdown (Scabard) export back into a character.
 *
 * The markdown written by buildMarkdown() (sheet.js) is a play-facing dossier of
 * DERIVED values: final attributes, final skill ratings, computed armor totals.
 * It was never a save format. Two paths bring a character back from one:
 *
 *   1. THE PAYLOAD. Every export now ends with an HTML comment holding the build
 *      itself, base64'd — invisible in Scabard and in any markdown viewer, ~8KB.
 *      When it's there, the restore is exact and no prose is parsed.
 *
 *   2. THE PARSER. For files exported before that existed, the prose is read
 *      back as best it can be. That is genuinely lossy — priorities, armor
 *      quality/style/extras, augment grades, what was bought vs. granted — so
 *      the result is an approximation and the report says exactly where.
 *
 * Either way the character lands in the CHARACTER GENERATOR, unfinalized, with
 * everything it owns as build items: the point is to rework and re-finalize it,
 * not to pretend the dossier was a save.
 *
 * The parser is coupled to buildMarkdown()'s output format with nothing in the
 * language to enforce it. `report.unparsedLines` is the canary: QA asserts it's
 * empty on a round trip, so a change to the export shows up as "12 lines I
 * didn't understand" rather than as silent data loss.
 */
"use strict";

/* ---------------------------------------------------------------- payload */

const MD_RESTORE_MARK = "sinless-restore v1";

/* Base64 that survives non-ASCII (ㄓ, ·, —, character names in any script).
   Chunked because String.fromCharCode(...bytes) blows the argument limit on a
   payload of any size. */
function mdEncodePayload(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function mdDecodePayload(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/* What gets embedded: the character as a BUILD, ready to be reworked.
 *
 * Everything owned is flattened into the chargen arrays — the kit copy and
 * anything bought in play both land there, because the dossier lists them
 * together and because a restored character is meant to be re-costed from
 * scratch. Play state is dropped (it belongs to a finalized character; see the
 * kit bright line in rules.js) except the notes, which nothing derives from.
 * Images are dropped too: they're 90% of a save's bytes and would bloat every
 * export by megabytes.
 */
function mdRestoreRecord(char) {
  const play = char.play || {};
  const purchases = play.purchases || {};
  const kitOrChargen = cat => (play.kit && play.kit[cat]) ? play.kit[cat] : (char[cat] || []);
  const rec = JSON.parse(JSON.stringify({
    name: char.name, player: char.player, description: char.description, notes: char.notes,
    // Provenance travels with the build, not with whoever last exported it — a
    // restore must not relabel an old character as made by today's version.
    // A null survives stringify, so "unstamped" round-trips as unstamped.
    app_version: char.app_version,
    house_rules: char.house_rules, priorities: char.priorities, heritage: char.heritage,
    attributes: char.attributes, cha_pool_choice: char.cha_pool_choice,
    skills: char.skills, skill_specializations: char.skill_specializations,
    ritual_skills: char.ritual_skills, etiquettes: char.etiquettes,
    martial_arts: char.martial_arts, magic: char.magic, speaker: char.speaker,
    lifestyles: char.lifestyles, lifestyle: char.lifestyle,
  }));
  for (const cat of RULES.KIT_CATEGORIES)
    rec[cat] = JSON.parse(JSON.stringify([...kitOrChargen(cat), ...(purchases[cat] || [])]));
  // Spells and Amp powers aren't kit categories — they live on `magic` — but
  // they can be bought in play, so fold those in the same way.
  rec.magic = rec.magic || {};
  rec.magic.spells = [...(rec.magic.spells || []), ...(purchases.spells || [])];
  rec.magic.amp_powers = [...(rec.magic.amp_powers || []), ...(purchases.amp_powers || [])];
  // Lifestyles drift in play (months tick down, one is current); play's list is
  // the truthful one if it exists.
  if ((play.lifestyles || []).length)
    rec.lifestyles = play.lifestyles.map(ls => ({ name: ls.name, months: ls.months }));
  rec.finalized = false;
  rec.play = { notes: play.notes || "" };
  return rec;
}

/* The comment appended to every export. Base64 keeps "-->" and stray markdown
   out of the comment body, so the payload can never break the document. */
function mdPayloadComment(char) {
  return `<!-- ${MD_RESTORE_MARK} ${mdEncodePayload(mdRestoreRecord(char))} -->`;
}
function mdReadPayload(text) {
  const m = new RegExp(`<!--\\s*${MD_RESTORE_MARK}\\s+([A-Za-z0-9+/=]+)\\s*-->`).exec(text);
  if (!m) return null;
  try { return mdDecodePayload(m[1]); } catch { return null; }
}

/* ------------------------------------------------------------ name lookup */

/* Which data table owns each kind of name, and the column it's keyed by.
   weapon_mods keys on "Modification", not "Weapon Mod" — easy to get wrong. */
const MD_NAME_TABLES = {
  weapons: ["weapons", "Weapon"],
  armor: ["armor", "Armor"],
  gear: ["misc_gear", "Item"],
  augments: ["augments", "Name"],
  decks: ["decks", "Name"],
  programs: ["programs", "Name"],
  rigs: ["rigs", "Rig Type"],
  drones: ["drones", "Drone"],
  vehicles: ["vehicles", "Vehicle"],
  spells: ["spells", "Name"],
  amp_powers: ["amp_powers", "Name"],
  rituals: ["rituals", "Name"],
  heritage_features: ["heritage_features", "Name"],
  martial_arts: ["martial_arts", "Style"],
  weapon_mods: ["weapon_mods", "Modification"],
  deck_mods: ["deck_mods", "Deck Mod"],
  rig_mods: ["rig_mods", "Rig Mod"],
  cyberguns: ["cyberguns", "Type"],
  lifestyles: ["lifestyles", "Lifestyle"],
};

function mdTableNames(kind) {
  const spec = MD_NAME_TABLES[kind];
  if (!spec) return [];
  const [table, col] = spec;
  const rows = (DATA.tables || {})[table] || [];
  const out = [];
  for (const r of rows) if (r[col]) out.push(String(r[col]));
  return [...new Set(out)];
}

/* Exact, then trimmed, then case-insensitive. A miss is REPORTED, never
   dropped quietly — that's how a renamed row or missing homebrew announces
   itself instead of the character just losing a rifle. */
function mdMatch(kind, raw, report, context) {
  const want = String(raw || "").trim();
  if (!want) return null;
  const names = mdTableNames(kind);
  const hit = names.find(n => n === want)
    || names.find(n => n.trim() === want)
    || names.find(n => n.toLowerCase() === want.toLowerCase());
  if (!hit) { report.unmatched.push({ context, raw: want }); return null; }
  return hit;
}

/* Comma-joined lists of data names (mod lists) split by longest prefix rather
   than on ", ", so a name containing a comma can't be torn in half. */
function mdSplitNames(text, kind, report, context) {
  const names = mdTableNames(kind).slice().sort((a, b) => b.length - a.length);
  const out = [];
  let rest = String(text || "").trim();
  while (rest) {
    const hit = names.find(n => rest === n || rest.startsWith(n + ", "));
    if (hit) {
      out.push(hit);
      rest = rest.slice(hit.length).replace(/^,\s*/, "");
      continue;
    }
    const comma = rest.indexOf(", ");
    const chunk = comma < 0 ? rest : rest.slice(0, comma);
    const matched = mdMatch(kind, chunk, report, context);
    if (matched) out.push(matched);
    rest = comma < 0 ? "" : rest.slice(comma + 2);
  }
  return out;
}

/* ------------------------------------------------------------- splitting */

const MD_KNOWN_SECTIONS = new Set(["Skills", "Magic", "Augments", "Weapons", "Armor",
  "Gear", "Decking", "Rigging", "Wealth & Advancement", "Notes"]);

/* `## Notes` holds arbitrary user prose that can contain "## Weapons" or a
 * convincing weapon row, so it never reaches the generic splitter: the notes
 * are cut off first, anchored to the one heading guaranteed to precede them.
 * `## Skills` and `## Wealth & Advancement` are the only unconditional
 * headings in buildMarkdown, which is what makes that anchor safe. */
function mdSplitSections(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const isHead = i => /^## (.+)$/.exec(lines[i]);
  const wealthAt = lines.findIndex(l => /^## Wealth & Advancement\s*$/.test(l));
  let notesAt = -1;
  for (let i = Math.max(0, wealthAt); i < lines.length; i++)
    if (/^## Notes\s*$/.test(lines[i])) { notesAt = i; break; }

  const headEnd = notesAt >= 0 ? notesAt : lines.length;
  let notes = notesAt >= 0 ? lines.slice(notesAt + 1) : [];
  // The footer is the export's own signature, not the player's note.
  while (notes.length && !notes[notes.length - 1].trim()) notes.pop();
  if (notes.length && /^\*Exported from the Sinless Character Dossier · /.test(notes[notes.length - 1]))
    notes.pop();
  while (notes.length && !notes[notes.length - 1].trim()) notes.pop();
  while (notes.length && !notes[0].trim()) notes.shift();

  const header = [];
  const sections = new Map();
  const unknownSections = [];
  let current = null;
  for (let i = 0; i < headEnd; i++) {
    const h = isHead(i);
    if (h) {
      const raw = h[1].trim();
      const name = raw.startsWith("Magic — ") ? "Magic" : raw;
      if (!MD_KNOWN_SECTIONS.has(name)) { unknownSections.push(raw); current = null; continue; }
      current = [];
      sections.set(name, current);
      sections.set(name + ":arg", raw.startsWith("Magic — ") ? raw.slice("Magic — ".length) : "");
      continue;
    }
    if (current) current.push(lines[i]);
    else header.push(lines[i]);
  }
  return { header, sections, notes: notes.join("\n"), unknownSections };
}

/* --------------------------------------------------------------- parsing */

const MD_ATTR_BY_ABBR = { STR: "Strength", BOD: "Body", REA: "Reaction",
  INT: "Intelligence", WIL: "Willpower", CHA: "Charisma" };

function mdNewReport() {
  return { exact: false, recovered: [], approximated: [], lost: [], unmatched: [],
           skippedDerived: [], unparsedLines: [], unknownSections: [] };
}

/* House rules leak into the prose in three places, and they have to be settled
   before anything else is read: `priorities` decides how the priority guess
   works, and `engineering`/`ew` decide which skill NAMES exist to match against. */
function mdInferHouseRules(text) {
  const out = {};
  if (/\*\*Zuzus:\*\*/.test(text)) out.currency = "zuzus";
  else if (/\*\*Woolongs:\*\*/.test(text)) out.currency = "woolongs";
  if (/\bEngineering: /.test(text)) out.engineering = "classic";
  else if (/\bEngineering \d/.test(text)) out.engineering = "single";
  if (/Computer: Electronic Warfare/.test(text)) out.ew = "houserule";
  return out;
}

/* "Name 4" / "Name 3/5 (Pistols)" — the two-number form is a specialization,
   which the export prints as final−1 / final+1. */
function mdParseSkillItem(item, report) {
  const m = /^(.*?)\s+(\d+)(?:\/(\d+))?(?:\s+\((.*)\))?$/.exec(item.trim());
  if (!m) { report.unparsedLines.push({ section: "Skills", line: item }); return null; }
  const name = m[1].trim();
  const lo = parseInt(m[2], 10);
  const hi = m[3] == null ? null : parseInt(m[3], 10);
  if (hi != null && hi - lo !== 2)
    report.approximated.push({ item: name, was: `${lo}/${hi}`, now: `${hi - 1}`,
      why: "specialization split wasn't ±1 as exported" });
  return { name, final: hi != null ? hi - 1 : lo, spec: m[4] || null };
}

function mdParseCharacter(text) {
  const report = mdNewReport();
  const draft = RULES.defaultCharacter();
  draft.finalized = false;
  const { header, sections, notes, unknownSections } = mdSplitSections(text);
  report.unknownSections = unknownSections;
  const sec = n => sections.get(n) || [];
  const count = (category, n) => { if (n) report.recovered.push({ category, count: n }); };

  // ---- header: name, heritage, magic type, player, attribute finals
  const finals = {};
  let poolLine = "";
  for (const line of header) {
    const t = line.trim();
    if (!t) continue;
    let m;
    if ((m = /^# (.+)$/.exec(t))) { draft.name = m[1].trim(); continue; }
    if ((m = /^\*(.+)\*$/.exec(t)) && /·/.test(t) && !finals.Strength && !draft.heritage.type_set) {
      // "*Human (Bat) · Amp · Player: Josh*" — peel the player first, since a
      // player name can itself contain the separator.
      let rest = m[1];
      const pm = / · Player: (.*)$/.exec(rest);
      if (pm) { draft.player = pm[1].trim(); rest = rest.slice(0, pm.index); }
      const bits = rest.split(" · ").map(s => s.trim());
      if (bits[0]) {
        const hm = /^(.+?)\s*\((.+)\)$/.exec(bits[0]);
        draft.heritage.type = (hm ? hm[1] : bits[0]).trim();
        if (hm) draft.heritage.uplift_type = hm[2].trim();
        draft.heritage.type_set = true;
      }
      if (bits[1]) draft.magic.chosen_type = bits[1];
      continue;
    }
    if (/^\*\*(STR|BOD|REA|INT|WIL|CHA)\*\* /.test(t)) {
      for (const part of t.split(" · ")) {
        const am = /^\*\*(\w+)\*\* (-?\d+)$/.exec(part.trim());
        if (am && MD_ATTR_BY_ABBR[am[1]]) finals[MD_ATTR_BY_ABBR[am[1]]] = parseInt(am[2], 10);
      }
      continue;
    }
    if (/^\*\*(Brawn|Finesse|Focus|Resolve)\*\* /.test(t)) { poolLine = t; continue; }
    if ((m = /^> ⚠ Heritage features: (.+?)\.?$/.exec(t))) {
      for (const f of mdSplitNames(m[1], "heritage_features", report, "Heritage features"))
        draft.heritage.features.push(f);
      count("Heritage features", draft.heritage.features.length);
      continue;
    }
    // Everything else in the header is derived (combat line, martial-art line,
    // other warnings, the wound-rule note) and is rebuilt by the engine.
  }
  delete draft.heritage.type_set;
  if (!draft.heritage.type) draft.heritage.type = "Human";

  // ---- skills
  const skillFinals = {};
  for (const line of sec("Skills")) {
    const t = line.trim();
    if (!t) continue;
    let m;
    if ((m = /^\*\*(Brawn|Finesse|Focus|Resolve) \(\d+d\)\*\*: (.+)$/.exec(t))) {
      for (const item of m[2].split(" · ")) {
        const parsed = mdParseSkillItem(item, report);
        if (!parsed) continue;
        if (!(parsed.name in (DATA.skills || {}))) {
          report.unmatched.push({ context: "Skill", raw: parsed.name });
          continue;
        }
        skillFinals[parsed.name] = parsed.final;
        if (parsed.spec)
          draft.skill_specializations[parsed.name] = { on: true, text: parsed.spec };
      }
      continue;
    }
    if ((m = /^\*\*Etiquettes:\*\* (.+)$/.exec(t))) {
      for (const item of m[1].split(" · ")) {
        const em = /^(.+?)\s+(\d+)$/.exec(item.trim());
        if (em) draft.etiquettes[em[1].trim()] = parseInt(em[2], 10);
      }
      count("Etiquettes", Object.keys(draft.etiquettes).length);
      continue;
    }
    if ((m = /^\*\*Knowledges:\*\* (.+)$/.exec(t))) {
      for (const item of m[1].split(" · ")) {
        const km = /^(.+?)\s+(\d+)$/.exec(item.trim());
        if (km) draft.knowledge_skills.push({ name: km[1].trim(), points: parseInt(km[2], 10) });
      }
      count("Knowledge skills", draft.knowledge_skills.length);
      continue;
    }
    if ((m = /^\*\*Ritual skills:\*\* (.+)$/.exec(t))) {
      for (const item of m[1].split(" · ")) {
        const rm = /^(.+?)\s+(\d+)$/.exec(item.trim());
        if (!rm) continue;
        const name = mdMatch("rituals", rm[1], report, "Ritual skill");
        if (name) draft.ritual_skills[name] = parseInt(rm[2], 10);
      }
      continue;
    }
    if ((m = /^\*\*Martial Art — (.+?) \(rank (\d+)\):\*\*/.exec(t))) {
      const style = mdMatch("martial_arts", m[1], report, "Martial art");
      if (style) draft.martial_arts.push({ style, rank: parseInt(m[2], 10) });
      continue;
    }
    // Derived: situational-dice list, the specialization footnote, Bling.
    if (/^\*Situational skill dice:\*$/.test(t) || /^- \*\*/.test(t)
        || /^\*Specialized skills read/.test(t) || /^\*\*Bling:\*\*/.test(t)) continue;
    report.unparsedLines.push({ section: "Skills", line: t });
  }
  count("Skills", Object.keys(skillFinals).length);

  // ---- magic
  const magicArg = sections.get("Magic:arg");
  if (magicArg) draft.magic.chosen_type = magicArg;
  for (const line of sec("Magic")) {
    const t = line.trim();
    if (!t) continue;
    let m;
    if ((m = /^\*\*Spells\*\*[^:]*: (.+)$/.exec(t))) {
      for (const item of m[1].split(" · ")) {
        const sm = /^(.+?)\s+\(F(\d+)(?:\s*⚠lethal)?\)$/.exec(item.trim());
        if (!sm) { report.unparsedLines.push({ section: "Magic", line: item }); continue; }
        const name = mdMatch("spells", sm[1], report, "Spell");
        if (name) draft.magic.spells.push({ name, force: parseInt(sm[2], 10) });
      }
      count("Spells", draft.magic.spells.length);
      continue;
    }
    if ((m = /^\*\*Amp powers:\*\* (.+)$/.exec(t))) {
      for (const item of m[1].split(" · ")) {
        const pm = /^(.+?)(?:\s+→\s+(.+?))?(?:\s+×(\d+))?$/.exec(item.trim());
        if (!pm) continue;
        const name = mdMatch("amp_powers", pm[1], report, "Amp power");
        if (name) draft.magic.amp_powers.push({ name, target: pm[2] || "",
          times: pm[3] ? parseInt(pm[3], 10) : 1 });
      }
      count("Amp powers", draft.magic.amp_powers.length);
      continue;
    }
    if ((m = /^\*\*Spirit relationships:\*\* (.+?) \(bonds: (\d+)\)$/.exec(t))) {
      draft.speaker.relationships = m[1].split(" · ").map(s => s.trim()).filter(Boolean);
      draft.speaker.bonds = parseInt(m[2], 10);
      count("Spirit relationships", draft.speaker.relationships.length);
      continue;
    }
    if ((m = /^\*\*Infusions:\*\* (.+)$/.exec(t))) {
      draft.speaker.infusions = m[1].split(" · ").map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (/^\*\*Bond \d+:\*\*/.test(t)) continue;      // play state (bond slots)
    report.unparsedLines.push({ section: "Magic", line: t });
  }

  // ---- augments
  for (const line of sec("Augments")) {
    const t = line.trim();
    if (!t) continue;
    if (/^- \*Senses & immunities:\*/.test(t)) continue;      // derived
    const m = /^- (.+)$/.exec(t);
    if (!m) { report.unparsedLines.push({ section: "Augments", line: t }); continue; }
    const bits = m[1].split(" — ");
    let namePart = bits[0].trim();
    let times = 1;
    const xm = /^(.+?)\s+×(\d+)$/.exec(namePart);
    if (xm) { namePart = xm[1].trim(); times = parseInt(xm[2], 10); }
    const name = mdMatch("augments", namePart, report, "Augment");
    if (!name) continue;
    const entry = { name, count: times };
    for (const extra of bits.slice(1)) {
      const v = extra.trim();
      if (/^DMG /.test(v)) continue;                          // derived
      if (name === "Cybergun Installation") {
        const gun = mdMatch("cyberguns", v, report, "Cybergun type");
        if (gun) entry.gunType = gun;
      }
    }
    draft.augments.push(entry);
  }
  count("Augments", draft.augments.length);

  // ---- weapons: owned rows only.
  //
  // The section also lists cyberguns (which come from the Cybergun Installation
  // augment), heritage-granted weapons and trait mounts. Re-importing those as
  // owned would duplicate them AND charge for them. Owned rows are the only
  // ones buildMarkdown gives a "· Conceal " to, which is the one reliable
  // discriminator — name alone isn't ("Elbow Spurs" is both a granted weapon
  // and a weapons-table row).
  let weaponRows = 0;
  for (const line of sec("Weapons")) {
    const t = line.trim();
    if (!t) continue;
    let m;
    if (/^- \*Optics:\*/.test(t)) continue;                    // derived
    if ((m = /^- \*\*(.+?)\*\* — (.+?) \((Heavy Torso|No Head) mount\)$/.exec(t))) {
      // A free mount is a heritage PICK, not an owned weapon — restoring it
      // duplicates nothing because it lives on `heritage`.
      const label = m[1].trim();
      if (m[3] === "No Head") draft.heritage.no_head_mount = label;
      else {
        const slot = draft.heritage.heavy_torso_mounts.findIndex(x => !x);
        if (slot >= 0) draft.heritage.heavy_torso_mounts[slot] = label;
      }
      report.recovered.push({ category: `${m[3]} mount`, count: 1, detail: label });
      continue;
    }
    m = /^- \*\*(.+?)\*\*( \(smart\))? — (.+)$/.exec(t);
    if (!m) { report.unparsedLines.push({ section: "Weapons", line: t }); continue; }
    const rest = m[3];
    if (/^Cybergun — /.test(m[1]) || !/ · Conceal /.test(rest)) {
      report.skippedDerived.push({ context: "Weapons", raw: m[1] });
      continue;
    }
    weaponRows++;
    const mods = /— mods: (.+)$/.exec(rest);
    const name = mdMatch("weapons", m[1], report, "Weapon");
    if (!name) continue;
    const row = (DATA.tables.weapons || []).find(x => x.Weapon === name) || {};
    const entry = { name, smart: Boolean(m[2]) || Boolean(row["Integrated Smart"]),
      mods: mods ? mdSplitNames(mods[1], "weapon_mods", report, "Weapon mod") : [],
      equipped: true, qty: 1 };
    if (RULES.bowRating(row, {})) {
      entry.min_str = 1;
      report.approximated.push({ item: name, was: "drawn to some Strength", now: "Min STR 1",
        why: "a bow's draw weight isn't in the export — re-pick it on Weapons & Armor" });
    }
    draft.weapons.push(entry);
  }
  count("Weapons", draft.weapons.length);
  // If a weapons section had rows but not one of them carried Conceal, the
  // export format has moved and the discriminator is gone. Say so rather than
  // silently importing a character with no weapons.
  if (sec("Weapons").some(l => /^- \*\*/.test(l.trim())) && !weaponRows)
    report.lost.push({ what: "Every weapon", why: "none of the rows looked like owned weapons — "
      + "this file may come from a newer version of the app" });

  // ---- armor
  for (const line of sec("Armor")) {
    const t = line.trim();
    if (!t) continue;
    const m = /^- \*\*(.+?)\*\* — .*?(\(worn\))?$/.exec(t);
    if (!m) { report.unparsedLines.push({ section: "Armor", line: t }); continue; }
    const name = mdMatch("armor", m[1], report, "Armor");
    if (!name) continue;
    draft.armor.push({ name, style: "", material: "", extras: [], active: Boolean(m[2]) });
  }
  count("Armor", draft.armor.length);

  // ---- gear (which also carries lifestyles)
  for (const line of sec("Gear")) {
    if (/^\s{2}- \*Effect:\*/.test(line)) continue;            // derived blurb
    const t = line.trim();
    if (!t) continue;
    let m;
    if ((m = /^- Lifestyle: (.+?) — (\d+) month\(s\) prepaid(\s+\*\*\(current\)\*\*)?$/.exec(t))) {
      const name = mdMatch("lifestyles", m[1], report, "Lifestyle");
      if (name) {
        draft.lifestyles.push({ name, months: parseInt(m[2], 10) });
        if (m[3]) draft.lifestyle = { name, months: parseInt(m[2], 10) };
        report.approximated.push({ item: `Lifestyle: ${name}`, was: "months at export time",
          now: `${m[2]} month(s)`, why: "prepaid months tick down in play — this is what was left" });
      }
      continue;
    }
    m = /^- (.+)$/.exec(t);
    if (!m) { report.unparsedLines.push({ section: "Gear", line: t }); continue; }
    let namePart = m[1].trim();
    let qty = 1;
    const xm = /^(.+?)\s+×(\d+)$/.exec(namePart);
    if (xm) { namePart = xm[1].trim(); qty = parseInt(xm[2], 10); }
    const name = mdMatch("gear", namePart, report, "Gear");
    if (name) draft.gear.push({ name, qty, link: "", carried: true });
  }
  count("Gear", draft.gear.length);
  count("Lifestyles", draft.lifestyles.length);

  // ---- decking
  for (const line of sec("Decking")) {
    const t = line.trim();
    if (!t) continue;
    let m;
    if ((m = /^- Deck: \*\*(.+?)\*\*(?: \((.+?)\))? — (.+)$/.exec(t))) {
      const name = mdMatch("decks", m[1], report, "Deck");
      if (!name) continue;
      const entry = { name, mods: m[2] ? mdSplitNames(m[2], "deck_mods", report, "Deck mod") : [] };
      const run = /^running (.+)$/.exec(m[3].trim());
      if (run) entry.hacking = run[1].trim();
      draft.decks.push(entry);
      continue;
    }
    if ((m = /^- Programs: (.+)$/.exec(t))) {
      for (const p of m[1].split(" · ")) {
        const name = mdMatch("programs", p, report, "Program");
        if (name) draft.programs.push(name);
      }
      continue;
    }
    report.unparsedLines.push({ section: "Decking", line: t });
  }
  count("Decks", draft.decks.length);
  count("Programs", draft.programs.length);

  // ---- rigging
  for (const line of sec("Rigging")) {
    const t = line.trim();
    if (!t) continue;
    const m = /^- (Rig|Drone|Vehicle): \*\*(.+?)\*\*(?: \((.+?)\))?(?: — (.+))?$/.exec(t);
    if (!m) { report.unparsedLines.push({ section: "Rigging", line: t }); continue; }
    const kind = { Rig: "rigs", Drone: "drones", Vehicle: "vehicles" }[m[1]];
    // "**Label** (Real Name)" when the unit was renamed in play.
    const realName = m[3] || m[2];
    const name = mdMatch(kind, realName, report, m[1]);
    if (!name) continue;
    const entry = { name, weapons: [], mods: [] };
    if (m[3]) entry.label = m[2].trim();
    if (kind === "rigs") delete entry.weapons;
    for (const bit of (m[4] || "").split(" · ")) {
      const b = bit.trim();
      if (!b) continue;
      let bm;
      if ((bm = /^weapons: (.+)$/.exec(b))) {
        const tables = (RULES.UNIT_ATTACHMENT_TABLES || {})[kind];
        const kinds = tables ? tables.weapons.map(([tk, nc]) => [tk, nc]) : [];
        entry.weapons = b.slice("weapons: ".length).split(", ").map(w => w.trim()).filter(Boolean)
          .map(w => {
            for (const [tk, nc] of kinds)
              if (((DATA.tables || {})[tk] || []).some(r => r[nc] === w)) return w;
            report.unmatched.push({ context: `${m[1]} weapon`, raw: w });
            return null;
          }).filter(Boolean);
        continue;
      }
      if ((bm = /^mods: (.+)$/.exec(b))) {
        const modKind = kind === "rigs" ? "rig_mods" : null;
        if (modKind) entry.mods = mdSplitNames(bm[1], modKind, report, "Rig mod");
        else {
          const tables = (RULES.UNIT_ATTACHMENT_TABLES || {})[kind];
          const [tk, nc] = tables ? tables.mods : [null, null];
          const known = tk ? ((DATA.tables || {})[tk] || []).map(r => r[nc]) : [];
          entry.mods = bm[1].split(", ").map(x => x.trim()).filter(Boolean).map(x => {
            if (known.includes(x)) return x;
            report.unmatched.push({ context: `${m[1]} mod`, raw: x });
            return null;
          }).filter(Boolean);
        }
        continue;
      }
      // Anything else in that position is the condition (Blinged, Poor, …).
      if ((RULES.VEHICLE_CONDITIONS || []).includes(b)) entry.condition = b;
      else report.unparsedLines.push({ section: "Rigging", line: b });
    }
    draft[kind].push(entry);
  }
  count("Rigs", draft.rigs.length);
  count("Drones", draft.drones.length);
  count("Vehicles", draft.vehicles.length);

  // ---- notes
  if (notes) { draft.play.notes = notes; draft.notes = notes; }

  return { draft, finals, skillFinals, poolLine, report };
}

/* ------------------------------------------- finals → what was actually bought
 *
 * scoreAttributes computes final = base + adjust and scoreSkills computes
 * final = max(points + bonus, soft, groupValue), and NEITHER adjust nor bonus
 * depends on the base. Everything feeding them — heritage, uplift, features,
 * augments, amp powers — has already been recovered. So the engine can be used
 * as an oracle: ask it what the modifiers are, and subtract them.
 *
 * The alternative (treat printed finals as bought) charges skill points for
 * dice the character never bought — group fallback and Skillsofts especially —
 * which is the single most expensive silent error available here. */
/* Priorities decide whether a character's magic is even switched on: at magic
 * priority 0 the type resolves to Hedge and every Amp power goes inert, so an
 * "Attribute Increase → Body" stops contributing and the base derived from the
 * printed final comes out one too high. Seed the minima the heritage and magic
 * type imply BEFORE deriving anything, and leave the other three at the top so
 * nothing else is suppressed either. mdInferPriorities lowers them afterwards,
 * never below these minima. */
function mdPriorityMinima(draft) {
  return {
    heritage: { Human: 0, Replicant: 0, Synthetic: 1 }[draft.heritage.type] ?? 2,
    magic: { Hedge: 0, Amp: 2, Speaker: 2, Mage: 3, Archmage: 4 }[draft.magic.chosen_type] ?? 0,
  };
}
function mdSeedPriorities(draft) {
  const min = mdPriorityMinima(draft);
  draft.priorities = { heritage: min.heritage, magic: min.magic,
                       attributes: 4, skills: 4, resources: 4 };
}

function mdDeriveBases(draft, finals, skillFinals, report) {
  const clone = () => JSON.parse(JSON.stringify(draft));
  for (const [attr, v] of Object.entries(finals)) draft.attributes[attr] = Math.max(1, v);
  for (const [skill, v] of Object.entries(skillFinals)) draft.skills[skill] = Math.max(0, v);

  let calc = RULES.calculate(clone());
  for (const [attr, want] of Object.entries(finals)) {
    const adj = (calc.attributes[attr] || {}).adjust || 0;
    draft.attributes[attr] = Math.max(1, Math.min(29, want - adj));
  }
  for (const [skill, want] of Object.entries(skillFinals)) {
    const s = calc.skills[skill] || {};
    if (s.soft && want <= s.soft) {
      draft.skills[skill] = 0;
      report.approximated.push({ item: skill, was: `rating ${want}`, now: "0 points",
        why: "those dice come from a Skillsoft, not from ranks you bought" });
      continue;
    }
    if (s.group_value != null && want <= s.group_value) {
      draft.skills[skill] = 0;
      report.approximated.push({ item: skill, was: `rating ${want}`, now: "0 points",
        why: "those dice come from the skill's group, not from ranks you bought" });
      continue;
    }
    draft.skills[skill] = Math.max(0, want - (s.bonus || 0));
  }

  // Group fallback shifts as siblings change, so settle it.
  for (let pass = 0; pass < 3; pass++) {
    calc = RULES.calculate(clone());
    let moved = false;
    for (const [skill, want] of Object.entries(skillFinals)) {
      const got = (calc.skills[skill] || {}).final;
      if (got === want || draft.skills[skill] === 0) continue;
      draft.skills[skill] = Math.max(0, draft.skills[skill] + (want - got));
      moved = true;
    }
    if (!moved) break;
  }

  return calc;
}

/* The last word: run the finished character and report anything that still
 * doesn't match the dossier, rather than quietly accepting it. Called after
 * priorities are settled, since those can switch magic on and off. */
function mdVerifyFinals(draft, finals, skillFinals, report) {
  const calc = RULES.calculate(JSON.parse(JSON.stringify(draft)));
  for (const [attr, want] of Object.entries(finals)) {
    const got = (calc.attributes[attr] || {}).final;
    if (got !== want)
      report.approximated.push({ item: attr, was: `${want}`, now: `${got}`,
        why: "couldn't be rebuilt exactly from the printed total" });
  }
  for (const [skill, want] of Object.entries(skillFinals)) {
    const got = (calc.skills[skill] || {}).final;
    if (got !== want)
      report.approximated.push({ item: skill, was: `rating ${want}`, now: `rating ${got}`,
        why: "couldn't be rebuilt exactly from the printed total" });
  }
  return calc;
}

/* Charisma adds a quarter of itself to exactly one pool, so the printed pool
   line identifies which one. */
function mdInferChaPool(draft, poolLine, report) {
  const want = {};
  for (const part of String(poolLine).split(" · ")) {
    const m = /^\*\*(Brawn|Finesse|Focus|Resolve)\*\* (\d+)$/.exec(part.trim());
    if (m) want[m[1]] = parseInt(m[2], 10);
  }
  if (!Object.keys(want).length) return;
  const hits = [];
  for (const pool of ["Brawn", "Finesse", "Focus", "Resolve"]) {
    const trial = JSON.parse(JSON.stringify(draft));
    trial.cha_pool_choice = pool;
    const c = RULES.calculate(trial);
    if (Object.entries(want).every(([p, v]) => c.pools[p] === v)) hits.push(pool);
  }
  if (hits.length === 1) { draft.cha_pool_choice = hits[0]; return; }
  report.lost.push({ what: "Charisma pool choice",
    why: hits.length ? `could be ${hits.join(" or ")} — left as ${draft.cha_pool_choice}`
                     : "the printed pools didn't match any choice; left as " + draft.cha_pool_choice });
}

/* Priorities aren't in the export. Infer a legal starting point from the hard
   minima the heritage and magic type imply, then cover the measured demand as
   best a legal assignment can. Always labelled a guess in the report. */
function mdInferPriorities(draft, report) {
  const classic = (draft.house_rules || {}).priorities !== "point";
  const { heritage: minHeritage, magic: minMagic } = mdPriorityMinima(draft);

  // What the build actually needs, measured with nothing suppressed.
  const probe = JSON.parse(JSON.stringify(draft));
  probe.priorities = { heritage: 4, magic: 4, attributes: 4, skills: 4, resources: 4 };
  const c = RULES.calculate(probe);
  const need = {
    attributes: (c.attr_points || {}).spent || 0,
    skills: (c.skill_points || {}).spent || 0,
    resources: (c.budget || {}).spent || 0,
  };
  const rows = (DATA.tables.priorities || []).slice()
    .map(r => ({ level: +r.Priority, attributes: +r.AttributePoints,
                 skills: +r.SkillPoints, resources: +r.Cash }));
  const supply = (cat, level) => {
    const row = rows.find(r => r.level === level) || rows[0] || {};
    return row[cat] || 0;
  };
  const shortfall = assign => ["attributes", "skills", "resources"]
    .reduce((n, cat) => n + Math.max(0, (need[cat] - supply(cat, assign[cat])) / Math.max(1, need[cat])), 0);

  let best = null;
  const levels = [0, 1, 2, 3, 4];
  const perms = a => a.length <= 1 ? [a]
    : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
  if (classic) {
    for (const p of perms(levels)) {
      const cand = { heritage: p[0], magic: p[1], attributes: p[2], skills: p[3], resources: p[4] };
      if (cand.heritage < minHeritage || cand.magic < minMagic) continue;
      const s = shortfall(cand);
      if (!best || s < best.s) best = { s, cand };
    }
  } else {
    for (const a of levels) for (const sk of levels) for (const r of levels) {
      const cand = { heritage: minHeritage, magic: minMagic, attributes: a, skills: sk, resources: r };
      if (Object.values(cand).reduce((x, y) => x + y, 0) > 10) continue;
      const s = shortfall(cand);
      if (!best || s < best.s) best = { s, cand };
    }
  }
  if (best) draft.priorities = best.cand;
  const label = p => `Heritage ${p.heritage} · Magic ${p.magic} · Attributes ${p.attributes} `
    + `· Skills ${p.skills} · Resources ${p.resources}`;
  report.lost.push({ what: "Priorities",
    why: `not in the export — guessed as ${label(draft.priorities)}. Check the Priorities tab first.` });
}

/* The permanent losses, stated once so the player knows what to re-enter. */
function mdNoteKnownLosses(draft, report, calc) {
  const L = report.lost;
  // A character who advanced in play has those advances baked into the printed
  // finals, so it rebuilds over budget by construction. Say so before the rail
  // does, or the import reads as broken.
  const over = [
    ["Skill points", (calc.skill_points || {}).remaining],
    ["Attribute points", (calc.attr_points || {}).remaining],
    ["Cash", (calc.budget || {}).remaining],
  ].filter(([, n]) => typeof n === "number" && n < 0)
   .map(([what, n]) => `${what} ${Math.round(-n).toLocaleString()} over`);
  if (over.length)
    L.push({ what: "This build comes out over budget",
      why: `${over.join(", ")} — the export prints finished numbers, so anything gained in play `
        + "(advances, purchases) is baked into them. Trim it back, or raise the priorities." });
  L.push({ what: "Armor Quality, Style and Extras",
    why: "the export prints an armor's base rating only — re-pick them on the Gear tab" });
  L.push({ what: "Augment α-grade, Fashionware quality, Skillsoft targets",
    why: "not printed; they change cost and ZR, so re-set them on the Augments tab" });
  L.push({ what: "Which items were bought in play",
    why: "everything came back as part of the build and costs creation cash" });
  L.push({ what: "Cash, Kismet, damage, advances and images",
    why: "play state — a rebuilt character starts fresh from Finalize" });
  L.push({ what: "Augments mounted on gear, weapon Equip flags, thrown quantities, focus links",
    why: "not printed" });
  if (["Green", "Blighted"].includes(draft.heritage.type))
    L.push({ what: "Nature's Blessing attributes",
      why: "the +3 and +1 picks aren't printed, so those two attributes came back 3 and 1 too high — "
        + "set the blessing on the Heritage tab and lower them to match" });
  if (draft.heritage.type === "Synthetic")
    L.push({ what: "Specialization pool",
      why: "a Synthetic's specialized pool isn't printed — re-pick it on the Heritage tab" });
}

/* ------------------------------------------------------------ the report UI */

function mdReportModal(report, name) {
  return new Promise(resolve => {
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = val => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(val); };
    const onKey = e => { if (e.key === "Escape") done(null); };
    const keep = el("input", { type: "checkbox", checked: 1 });

    const group = (title, rows) => rows.length ? el("details", { class: "desc-expander" },
      el("summary", {}, `${title} (${rows.length})`),
      el("div", { class: "desc-body" }, ...rows.map(r => el("div", { class: "sub" }, r)))) : null;

    const recovered = report.recovered.filter(r => r.count)
      .map(r => `${r.category}: ${r.count}${r.detail ? ` — ${r.detail}` : ""}`);
    const approx = report.approximated.map(a => `${a.item}: ${a.was} → ${a.now} — ${a.why}`);
    const lost = report.lost.map(l => `${l.what} — ${l.why}`);
    const unmatched = report.unmatched.map(u => `${u.context}: “${u.raw}”`);
    const unparsed = report.unparsedLines.map(u => `${u.section}: ${u.line}`);

    const modal = el("div", { class: "card mount-modal", style: "max-width:620px" },
      el("h3", {}, report.exact ? "Restored from the embedded build" : "Rebuilt from Markdown"),
      el("p", { class: "hint" }, report.exact
        ? `“${name}” carried an exact copy of its build, so nothing was guessed. It opens in the `
          + "character generator, unfinalized, with everything it owned as build items — cash, "
          + "Kismet and damage don't come back."
        : `“${name}” was rebuilt from the dossier text. A Scabard export prints finished numbers, `
          + "not the choices behind them, so this is an approximation: it opens in the character "
          + "generator so you can put right what the export couldn't carry."),
      ...[group("Came back", recovered),
          group("Approximated", approx),
          group("Not in the export", lost),
          group("Names I couldn't find", unmatched),
          group("Lines I didn't understand", unparsed)].filter(Boolean),
      unmatched.length ? el("p", { class: "hint", style: "color:var(--amber)" },
        "Names I couldn't find were NOT imported — they're either renamed rows or homebrew this "
        + "browser doesn't have installed.") : null,
      el("label", { class: "opt", style: "margin-top:10px" }, keep,
        el("span", {}, "Keep this report in the character's Notes")),
      el("p", { class: "hint" },
        "The rail on the left will show every budget this character is over. That's expected — "
        + "fix them and Finalize again."),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
        el("button", { class: "btn-add", onclick: () => done({ keep: keep.checked }) },
          "Open in chargen"),
        el("button", { class: "btn ghost", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
  });
}

function mdReportText(report) {
  const lines = [`--- Markdown import report (${new Date().toISOString().slice(0, 10)}) ---`];
  const block = (title, rows) => { if (rows.length) { lines.push(title); rows.forEach(r => lines.push("  " + r)); } };
  block("Came back:", report.recovered.filter(r => r.count).map(r => `${r.category}: ${r.count}`));
  block("Approximated:", report.approximated.map(a => `${a.item}: ${a.was} -> ${a.now} (${a.why})`));
  block("Not in the export:", report.lost.map(l => `${l.what} - ${l.why}`));
  block("Names not found:", report.unmatched.map(u => `${u.context}: ${u.raw}`));
  return lines.join("\n");
}

/* ---------------------------------------------------------- the entry point */

/* Does this look like one of our exports at all? Mirrors the JSON path's
   validateCharacterShape contract so both failures read the same. */
function mdSniff(text) {
  const problems = [];
  const t = String(text || "").replace(/\r\n?/g, "\n");
  if (!/^#\s+.+/m.test(t)) problems.push("no title line (a character export starts with “# Name”)");
  if (!/^## Skills\s*$/m.test(t)) problems.push("no “## Skills” section");
  return { ok: !problems.length, problems };
}

async function importMarkdownFile(file) {
  const text = await file.text();
  const sniff = mdSniff(text);
  if (!sniff.ok) {
    alert("That file doesn't look like a Sinless Markdown export:\n\n"
      + sniff.problems.map(p => "  • " + p).join("\n"));
    return;
  }

  let draft, report;
  const payload = mdReadPayload(text);
  if (payload) {
    draft = payload;
    report = mdNewReport();
    report.exact = true;
    for (const cat of [...RULES.KIT_CATEGORIES, "weapons"])
      if ((draft[cat] || []).length) report.recovered.push({ category: cat, count: draft[cat].length });
  } else {
    // House rules first: they decide the skill NAMES that exist to match
    // against, and how priorities are allocated.
    const seeded = Object.assign({}, RULES.defaultHouseRules
      ? RULES.defaultHouseRules() : (CHAR.house_rules || {}), mdInferHouseRules(text));
    const chosen = (typeof promptHouseRules === "function")
      ? await promptHouseRules(seeded) : seeded;
    if (!chosen) { await recalc(); return; }        // cancelled — restore globals
    const parsed = mdParseCharacter(text);
    draft = parsed.draft;
    report = parsed.report;
    draft.house_rules = chosen;
    // calculate() repoints the engine's house rules and reshapes the skill list
    // in place, so everything below runs on the imported character's rules and
    // the live one is restored before we return.
    RULES.calculate(JSON.parse(JSON.stringify(draft)));
    mdSeedPriorities(draft);      // before deriving: magic must be switched on
    mdDeriveBases(draft, parsed.finals, parsed.skillFinals, report);
    mdInferChaPool(draft, parsed.poolLine, report);
    mdInferPriorities(draft, report);
    const calc = mdVerifyFinals(draft, parsed.finals, parsed.skillFinals, report);
    mdNoteKnownLosses(draft, report, calc);
  }

  const answer = await mdReportModal(report, draft.name || "Unnamed");
  if (!answer) { await recalc(); return; }
  if (answer.keep)
    draft.play = Object.assign({}, draft.play,
      { notes: [mdReportText(report), (draft.play || {}).notes || ""].filter(Boolean).join("\n\n") });

  const merged = RULES.mergeDefaults(draft);
  merged.finalized = false;                     // never open a restore in play
  delete merged.saved_as;                       // it is not the character it came from
  merged.name = (typeof uniqueTabName === "function")
    ? uniqueTabName(merged.name || "Imported character", "imported")
    : (merged.name || "Imported character");
  STORAGE.saveCharacter(merged);
  await openCharacter(merged);
  if (typeof refreshLoadList === "function") refreshLoadList();
}
