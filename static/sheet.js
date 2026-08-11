/**
 * sheet.js — the interactive play-mode character sheet (after Finalize).
 *
 * Loaded after app.js and shares its globals (DATA/CHAR/CALC, el, $, fmt,
 * recalc). Chargen and play mode are two top-level views: #app (rail +
 * chargen tabs) and #sheet (this file); enterSheet()/exitSheet() toggle
 * between them. All play state lives under CHAR.play and is auto-saved
 * (debounced) to localStorage whenever it changes — no explicit Save button
 * in play mode.
 *
 * Derived stats (pools, condition maxima, attribute finals) still come from
 * CALC: rules.calculate() applies play advances AND play purchases (gear,
 * augments, amp powers, spells bought during play) on top of the chargen
 * build when character.finalized is true, so everything bought here flows
 * through the same engine as chargen.
 *
 * Kismet rules (per KISMET.docx):
 *   raise attribute +1    new level ≤10: 3 · 11–15: 4 · 16+: 5 Kismet
 *   raise skill +1        current skill level in Kismet, cannot exceed 6
 *   new skill (rank 1)    4 Kismet
 *   every 10 earned       +1 Kismet pool -> pick a boon (windfall / free
 *                         asset / skill mastery 6→7); every 2nd is a major
 * Magic in play:
 *   spells cost their listed Cost in woolongs PER FORCE to learn or advance
 *   ZP advances cost Kismet (assumed: same tier costs as attributes) and
 *   unlock higher-Force casting — drain is lethal when Force > ZP, Stun
 *   when Force <= ZP
 * House rules (not in KISMET.docx):
 *   wound penalty         −1 die per 3 filled boxes on EACH track, cumulative
 *                         (Biotech can remove the penalties during combat)
 */
"use strict";

const POOL_ORDER = ["Brawn", "Finesse", "Focus", "Resolve"];
const ATTR_ABBR = [["Strength", "STR"], ["Body", "BOD"], ["Reaction", "REA"],
  ["Intelligence", "INT"], ["Willpower", "WIL"], ["Charisma", "CHA"]];
const PLAY_SAVE_DEBOUNCE_MS = 600;
const SKILL_KISMET_CAP = 6;        // Kismet raises stop at 6; mastery boon reaches 7
const NEW_SKILL_KISMET_COST = 4;
const KNOWLEDGE_RANK_CAP = 6;      // mirrors rules.js KNOWLEDGE_ETIQUETTE_RANK_CAP

/* per KISMET.docx: "Grant Kismet at the end of a session as follows" */
const KISMET_AWARDS = [
  ["Survived the session", 1],
  ["Completed mission successfully", 2],
  ["Acquired paydata during run", 1],
  ["Optional objective completed", 1],
  ["Personal goal achieved", 5],
  ["Said what their character learned", 1],
];
const WINDFALL_TABLE = [
  "Gain 3d6×10 Techtronics",
  "Gain 3d6×10 Manastellite",
  "Gain a prototype Arcanatech (installed in a HQ: +1 to a brand stat permanently)",
  "Get 3d6 points of influence on a resource",
  "Get 3d6 points of Market Cap added to your brand's bank",
  "Gain 3d6 × 4,000ㄓ in cash or gear of rarity 4 or less",
];

/* Roll a single die and any `NdM` dice-expressions embedded in a string,
 * substituting each with its rolled total (honouring a trailing ×K / × K,KKK
 * multiplier). "Gain 3d6×10 Techtronics" -> "Gain 90 Techtronics". */
function rollDie(sides) { return Math.floor(Math.random() * sides) + 1; }
function rollDiceInText(text) {
  return String(text).replace(
    /(\d+)d(\d+)(?:\s*[×x*]\s*([\d,]+))?/gi,
    (_m, n, sides, mult) => {
      let total = 0;
      for (let i = 0; i < +n; i++) total += rollDie(+sides);
      if (mult) total *= parseInt(mult.replace(/,/g, ""), 10);
      return total.toLocaleString();
    });
}

// Hacking programs are priced in the programs table now (Hacking N = 5,000 × N).
const SPELL_FORCE_MAX = 6;           // spells are learned/advanced to Force 6 at most

/* Weapon Type -> the skill you roll to use it (everything else is Firearms) */
const WEAPON_SKILL_BY_TYPE = {
  Melee: "Melee Weapons",
  Thrown: "Throwing Weapons",
  GrenadeLauncher: "Heavy Weapons",
  Heavy: "Heavy Weapons",
  Energy: "Energy Weapons",
  Projectile: "Archery",
};
/* The ±1 a skill's specialization contributes for one specific weapon. Thin
   wrapper so the Overview dice chip and the Gear tab roll hint agree. */
function specAdjustFor(skill, weaponName, weaponType) {
  const entry = (CHAR.skill_specializations || {})[skill];
  return RULES.weaponSpecAdjust(entry, skill, weaponName, weaponType, DATA.tables);
}

/* Everything needed to roll one attack with one weapon.
 *
 * The split follows the combat sequence: "total the number of dice, skill +
 * accuracy to get your limit", then "total any bonus dice from firing mode,
 * bright light, point-blank range". So Accuracy is part of the LIMIT — it comes
 * out of the pool like the skill dice do — and only the firing mode, Gun-Kata
 * and the like are free.
 *
 * `skillDice` and `acc` are kept apart for the tooltip; `limitDice` is what the
 * roller loads as skill dice and what the pool pays for. The Overview's dice
 * chip renders this and the Fire button loads the roller from it, so the number
 * you click and the number you shoot with cannot drift apart. */
/* Weirding Way 1: a weapon with no reach is close enough to a fist that the
 * style lets you swing it as one — "Reach 0 weapons may use Unarmed Combat
 * instead of Melee Weapons or Cybertech Combat" (issue #34). Only ever an
 * upgrade: it applies when Unarmed is the better rating, so a specialist in
 * either of the other two is never dragged down to it. */
const MD_UNARMED_SWAPPABLE = ["Melee Weapons", "Cybertech Combat"];
function weirdingWayRank() {
  const ma = (CALC.martial_arts || []).find(m => /^weirding\s*way$/i.test(m.style || ""));
  return ma ? (+ma.rank || 0) : 0;
}
function unarmedSwapFor(skill, reach) {
  if (!MD_UNARMED_SWAPPABLE.includes(skill)) return null;
  if (reach == null || parseInt(reach, 10) !== 0) return null;
  if (weirdingWayRank() < 1) return null;
  const unarmed = ((CALC.skills || {})["Unarmed Combat"] || {}).final || 0;
  const current = ((CALC.skills || {})[skill] || {}).final || 0;
  return unarmed > current ? "Unarmed Combat" : null;
}

function weaponRollSpec(name, type, accuracy, bonuses = [], reach = null) {
  const mapped = RULES.weaponSkillName(name, type);
  const swapped = unarmedSwapFor(mapped, reach);
  const skill = swapped || mapped;
  const s = skill && (CALC.skills || {})[skill];
  if (!s) return null;
  const spec = specAdjustFor(skill, name, type);
  // Trained-only with no dice anywhere: the weapon can't be used at all.
  const locked = s.trained_only && !(s.final > 0 || s.dice_bonus);
  const skillDice = Math.max(0, s.final + spec.delta);
  const acc = +accuracy || 0;
  const limitDice = skillDice + acc;
  const bonus = bonuses.reduce((n, b) => n + (+b.dice || 0), 0);
  const why = [`${skill} ${s.final}`];
  if (swapped) why.push(`(Weirding Way: Reach 0, so ${mapped} gives way to Unarmed)`);
  if (spec.delta > 0) why.push(`+1 specialized in ${spec.term}`);
  if (spec.delta < 0) why.push(`−1 outside your specialty (${spec.term})`);
  why.push(`= ${skillDice} skill`);
  if (acc) why.push(`+ Accuracy ${acc} = ${limitDice} limit dice`);
  const bwhy = [];
  for (const b of bonuses) if (+b.dice) bwhy.push(`${b.label} +${b.dice}`);
  return { skill, pool: s.pool, spec, locked, skillDice, acc, limitDice, bonus, why, bwhy };
}

function weaponRollParts(type, weaponName, accuracy = 0, reach = null) {
  const mapped = WEAPON_SKILL_BY_TYPE[type] || "Firearms";
  const skill = unarmedSwapFor(mapped, reach) || mapped;
  const s = CALC.skills[skill] || {};
  const pool = s.pool || "Finesse";
  // final already folds in group-fallback dice, so no "grp" notation needed
  const spec = specAdjustFor(skill, weaponName, type);
  const rated = s.final > 0;
  const skillDice = rated ? Math.max(0, s.final + spec.delta) : 0;
  // Accuracy is part of the limit, not a free bonus, so it rides with the skill
  // dice here as it does on the Overview chip.
  const acc = +accuracy || 0;
  const dice = skillDice + (rated || acc ? acc : 0);
  const rating = rated ? skillDice : "untrained";
  // Name the specialty rather than just moving the number, so a rating that
  // differs from the Skills tab explains itself.
  const note = (rated && spec.delta > 0) ? ` (+1 ${spec.term})`
    : (rated && spec.delta < 0) ? ` (−1 outside ${spec.term})` : "";
  return { skill, pool, dice,
    text: `Roll ${pool} ${CALC.pools[pool]}d · ${skill} ${rating}${note}`
      + (acc ? ` + Acc ${acc} = ${dice}d` : "") };
}
function weaponRoll(type, weaponName) { return weaponRollParts(type, weaponName).text; }

const LIFESTYLE_EFFECTS = {
  Squatter: "Rough living: begin play with one Physical condition box already checked and take a −1 penalty die on all tests during the run.",
  Low: "Either start the game with one Physical box checked OR take −1 penalty die on tests until the end of the first conflict encounter.",
  Middle: "No special effect.",
  High: "Well rested: ignore your first penalty die on all tests during the run.",
  Wealthy: "Blend into affluent corporate enclaves and arcologies. +1 die to all etiquette tests (you may roll a one-die test even with etiquette 0), plus the High benefit (ignore your first penalty die).",
};

let sheetTab = "overview";
let expandedPool = null;      // pool card the user clicked open on Overview
let playSaveTimer = null;
let sheetMenuOpen = false;    // hamburger menu (Back to Chargen / Homebrew / Export / …)
let sheetHeadObserver = null; // IntersectionObserver toggling the compact sticky strip
let sheetStickyScrolled = false;  // survives re-renders so the strip doesn't flicker

/* ------------------------------------------------ play-state plumbing */
/* Top up CHAR.play with whatever is missing, so a character that predates a
 * field still gets it on the way into the sheet.
 *
 * The shape comes from RULES.defaultCharacter().play — one definition, so a
 * character created fresh and one topped up here end up with the same keys —
 * plus the fields below, which only the play sheet ever reads and the engine
 * has no opinion about. */
function ensurePlay() {
  const d = {
    ...RULES.defaultCharacter().play,
    pool_boost: {},                       // pool name -> temporary bonus dice
    pool_kismet: {},                      // pool name -> permanent Kismet-die boons
    images: [],                           // [{ url (data URL), caption, big }]
    infusion_spirits: {},                 // infusion slot -> spirit placed in it
    bond_slots: [],                       // [{ spirit, force, favors }] spirits placed in bonds
  };
  CHAR.play = CHAR.play || {};
  for (const [k, v] of Object.entries(d)) {
    if (CHAR.play[k] == null) CHAR.play[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)
             && CHAR.play[k] && typeof CHAR.play[k] === "object")
      for (const [k2, v2] of Object.entries(v))
        if (CHAR.play[k][k2] == null) CHAR.play[k][k2] = v2;
  }
  // The play shape is complete now, so the ledger exists and the one-time
  // repairs can log what they change. Both are guarded — each runs at most once.
  reconcileLifestyles();
  ensureKit();
  migrateHackingProgram();
  ensureCreationBudget();     // after the migration, so the freeze prices it
  return CHAR.play;
}
/* The hard line between chargen and play (JC-010, JC-024).
 *
 * Nothing bought after Finalize is written to the chargen arrays. Each category
 * lives in two places — `CHAR.<kind>` for what the character was built with,
 * `CHAR.play.purchases.<kind>` for what they've picked up since — and the sheet
 * shows the two joined, chargen first. That is the same order
 * `applyPlayAdvances` concatenates them in, so index N of this list is index N
 * of the matching CALC array and everything downstream can index straight
 * across.
 *
 * `ownedSplit` tags each entry with the array it lives in, so removing and
 * reordering hit the right one. Read-only consumers want the flat `all*`
 * versions.
 *
 * The first half is `play.kit` — play's own copy of what the character left
 * creation with, NOT the chargen arrays. `inPlay` still marks which side of
 * Finalize an item came from, because the sheet labels play purchases, but both
 * halves are equally play's to edit. Nothing here can reach the chargen record. */
function ownedSplit(category, starting, bought) {
  return [...starting.map((ref, i) => ({ ref, arr: starting, i, inPlay: false, category })),
          ...bought.map((ref, i) => ({ ref, arr: bought, i, inPlay: true, category }))];
}
function ownedWeapons()  { return ownedSplit("weapons", kitOf("weapons"), CHAR.play.purchases.weapons); }
function ownedArmor()    { return ownedSplit("armor", kitOf("armor"), CHAR.play.purchases.armor); }
function ownedDecks()    { return ownedSplit("decks", kitOf("decks"), CHAR.play.purchases.decks); }
function ownedRigs()     { return ownedSplit("rigs", kitOf("rigs"), CHAR.play.purchases.rigs); }
function ownedDrones()   { return ownedSplit("drones", kitOf("drones"), CHAR.play.purchases.drones); }
function ownedVehicles() { return ownedSplit("vehicles", kitOf("vehicles"), CHAR.play.purchases.vehicles); }
function ownedPrograms() { return ownedSplit("programs", kitOf("programs"), CHAR.play.purchases.programs); }
function ownedGear()     { return ownedSplit("gear", kitOf("gear"), CHAR.play.purchases.gear); }
function ownedAugments() { return ownedSplit("augments", kitOf("augments"), CHAR.play.purchases.augments); }

/* Flat views for read-only consumers — what the character HAS right now. */
function allWeapons()  { return [...kitOf("weapons"), ...CHAR.play.purchases.weapons]; }
function allArmor()    { return [...kitOf("armor"), ...CHAR.play.purchases.armor]; }
function allDecks()    { return [...kitOf("decks"), ...CHAR.play.purchases.decks]; }
function allPrograms() { return [...kitOf("programs"), ...CHAR.play.purchases.programs]; }
function allRigs()     { return [...kitOf("rigs"), ...CHAR.play.purchases.rigs]; }
function allDrones()   { return [...kitOf("drones"), ...CHAR.play.purchases.drones]; }
function allVehicles() { return [...kitOf("vehicles"), ...CHAR.play.purchases.vehicles]; }
function allGear()     { return [...kitOf("gear"), ...CHAR.play.purchases.gear]; }
function allAugmentsOwned() { return [...kitOf("augments"), ...CHAR.play.purchases.augments]; }
function allKnowledgeSkills() { return kitOf("knowledge_skills"); }
function allUnits(table) { return table === "drones" ? allDrones() : allVehicles(); }

function schedulePlaySave() {
  // Read-only shared views never persist (also server-rejected as non-owner).
  if (typeof activeTabObj === "function" && activeTabObj() && activeTabObj().readonly) return;
  clearTimeout(playSaveTimer);
  playSaveTimer = setTimeout(() => {
    if (!CHAR.name) return;
    STORAGE.saveCharacter(CHAR);
  }, PLAY_SAVE_DEBOUNCE_MS);
}
/* mutate play state -> autosave + redraw */
function playChanged(rerender = true) {
  schedulePlaySave();
  if (rerender) renderSheet();
}
async function playChangedRecalc() {   // for changes that alter derived stats
  schedulePlaySave();
  await recalc();
  renderSheet();
}

/* ------------------------------------------------ kismet + cash ledgers */
function kismetEcon() {
  const p = CHAR.play;
  const increases = Math.floor(p.kismet_earned / 10);   // pool +1 per 10 earned
  const majorsTotal = Math.floor(increases / 2);        // every 2nd is a major boon
  const regularsTotal = increases - majorsTotal;
  return {
    increases, majorsTotal, regularsTotal,
    regularsAvail: Math.max(0, regularsTotal - p.boons_spent),
    majorsAvail: Math.max(0, majorsTotal - p.major_boons_spent),
  };
}
function awardKismet(label, n) {
  CHAR.play.kismet += n;
  CHAR.play.kismet_earned += n;
  CHAR.play.kismet_log.unshift({ label, delta: n });
}
/* `undo`, when given, is a small serializable descriptor (not a closure —
 * kismet_log is persisted to localStorage as JSON) letting a later
 * undoKismetSpend() reverse the specific advance this spend made. */
function spendKismet(label, n, undo) {
  if (CHAR.play.kismet < n) { alert(`Not enough Kismet (need ${n}, have ${CHAR.play.kismet}).`); return false; }
  CHAR.play.kismet -= n;
  CHAR.play.kismet_log.unshift({ label, delta: -n, undo: undo || null });
  return true;
}

/* Reverses a still-undoable kismet_log entry: refunds the Kismet and rolls
 * back whichever play.*_advances counter the spend incremented, then drops
 * the entry from the ledger. Safe to call out of order — every advance is a
 * simple additive counter, so undoing one just subtracts 1 regardless of
 * what was spent afterward. */
function undoKismetSpend(entry) {
  const play = CHAR.play;
  const idx = play.kismet_log.indexOf(entry);
  if (idx < 0 || entry.delta >= 0 || !entry.undo) return;
  const u = entry.undo;
  const dec = (obj, key) => { obj[key] = Math.max(0, (obj[key] || 0) - 1); };
  if (u.kind === "attribute") dec(play.attribute_advances, u.name);
  else if (u.kind === "skill") dec(play.skill_advances, u.name);
  else if (u.kind === "martial_art") dec(play.martial_art_advances = play.martial_art_advances || {}, u.name);
  else if (u.kind === "ritual") dec(play.ritual_advances, u.name);
  else if (u.kind === "zp") play.zp_advances = Math.max(0, (play.zp_advances || 0) - 1);
  play.kismet -= entry.delta;   // delta is negative, so this refunds it
  play.kismet_log.splice(idx, 1);
}
/* `undo`, when given, is a small serializable descriptor (cash_log is persisted
 * as JSON, so no closures) naming what this spend bought, for undoCashSpend()
 * below. Spends with nothing to reverse — manual adjustments, α-grade
 * upgrades, quality changes — pass none and get no Undo button. */
function logCash(label, delta, undo) {
  CHAR.play.cash += delta;
  CHAR.play.cash_log.unshift(undo ? { label, delta, undo } : { label, delta });
}

/* Using something up belongs in the Activity ledger next to what was bought —
 * "where did my six doses go" is the same question as "where did my money go".
 * No cash moves (a spent dose isn't a sale), so it lands as a zero-delta note,
 * which the ledger already renders with a dash rather than a fake ㄓ0.
 *
 * Consecutive clicks on the same item fold into ONE line, because a stepper is
 * held down: taking three doses reads "Used 3 Bliss — 7 left", not three rows.
 * The fold only ever touches the newest entry, and only while it's still the
 * same item going the same direction, so it can't rewrite history. */
function logItemUse(name, delta, left) {
  if (!delta) return;
  const log = CHAR.play.cash_log;
  const top = log[0];
  const folds = top && top.use === name && Math.sign(top.use_n || 0) === Math.sign(delta);
  const n = (folds ? top.use_n : 0) + delta;
  const label = n < 0
    ? `Used ${-n} ${name} — ${left} left`
    : `Restocked ${n} ${name} from supplies — ${left} on hand`;
  if (folds) Object.assign(top, { label, use_n: n });
  else log.unshift({ label, delta: 0, use: name, use_n: n });
}

/* Reversing a cash purchase: the item goes and the money comes back in full.
 * Kismet spends have always had this; cash didn't, so removing a bought item
 * quietly kept the money. Undo lives only here in the Activity ledger — the
 * per-row ✕ on the Gear tab still just removes the thing, since selling for
 * face value on a whim isn't the same as taking back a misclick.
 *
 * Each handler returns true when it found and removed what the entry bought.
 * Items are located by NAME at undo time, most recent first: object identity
 * doesn't survive a save/load round trip. */
function removeNamedEntry(list, name) {
  const i = list.map(x => x.name).lastIndexOf(name);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}
function removeCountedEntry(list, name, countKey) {
  const i = list.map(x => x.name).lastIndexOf(name);
  if (i < 0) return false;
  const count = list[i][countKey] || 1;
  if (count > 1) list[i][countKey] = count - 1;
  else list.splice(i, 1);
  return true;
}
/* Undoing a FITTING (the ledger's "Fitted X to Y" / "Mounted X on Y" rows).
 *
 * Hosts are found by name, because object identity doesn't survive a save/load
 * round trip. On a chargen host the fitting is a play.fitted_mods record, so
 * undoing it drops that record rather than touching the chargen item — which
 * is the whole point, and what the old direct splice got wrong. */
function removeFromSublist(entries, hostName, key, name) {
  const play = CHAR.play;
  play.fitted_mods = play.fitted_mods || [];
  for (const entry of entries) {
    if (entry.ref.name !== hostName) continue;
    if (!entry.inPlay) {
      const i = play.fitted_mods.findIndex(r => r.category === entry.category
        && r.host === entry.i && r.list === key && r.name === name);
      if (i >= 0) { play.fitted_mods.splice(i, 1); return true; }
      continue;
    }
    const arr = entry.ref[key] || [];
    const i = arr.findIndex(x => sublistName(x) === name);
    if (i >= 0) { arr.splice(i, 1); return true; }
  }
  return false;
}
const CASH_UNDO = {
  weapon:    u => removeNamedEntry(CHAR.play.purchases.weapons, u.name),
  armor:     u => removeNamedEntry(CHAR.play.purchases.armor, u.name),
  // Amp powers cost ZP rather than cash, so they never reach this ledger.
  spell:     u => removeNamedEntry(CHAR.play.purchases.spells, u.name),
  deck:      u => removeNamedEntry(CHAR.play.purchases.decks, u.name),
  rig:       u => removeNamedEntry(CHAR.play.purchases.rigs, u.name),
  drone:     u => removeNamedEntry(CHAR.play.purchases.drones, u.name),
  vehicle:   u => removeNamedEntry(CHAR.play.purchases.vehicles, u.name),
  gear:      u => removeCountedEntry(CHAR.play.purchases.gear, u.name, "qty"),
  augment:   u => removeCountedEntry(CHAR.play.purchases.augments, u.name, "count"),
  // Programs are bare names, not entries.
  program: u => {
    const list = CHAR.play.purchases.programs;
    const i = list.lastIndexOf(u.name);
    if (i < 0) return false;
    list.splice(i, 1);
    CHAR.play.decking.loaded = (CHAR.play.decking.loaded || []).filter(n => n !== u.name);
    return true;
  },
  weapon_mod:  u => removeFromSublist(ownedWeapons(), u.host, "mods", u.name),
  armor_extra: u => removeFromSublist(ownedArmor(), u.host, "extras", u.name),
  deck_mod:    u => removeFromSublist(ownedDecks(), u.host, "mods", u.name),
  rig_mod:     u => removeFromSublist(ownedRigs(), u.host, "mods", u.name),
  mount: u => removeFromSublist(
    [...ownedWeapons(), ...ownedArmor(), ...ownedGear()], u.host, "mounted", u.name),
  lifestyle_month: u => {
    const ls = (CHAR.play.lifestyles || []).find(x => x.name === u.name);
    if (!ls || !(ls.months > 0)) return false;
    ls.months -= 1;
    return true;
  },
  // Undoing a disposal puts the item back where it was and takes the sale money
  // away again (undoCashSpend does the cash half). A loss logs delta 0, so
  // undoing one only returns the item.
  restore_item: u => {
    const list = u.inPlay ? (CHAR.play.purchases || {})[u.category] : kitOf(u.category);
    if (!Array.isArray(list) || u.entry === undefined) return false;
    list.splice(Math.max(0, Math.min(list.length, u.at)), 0, deepCopyEntry(u.entry));
    return true;
  },
  restore_mod: u => {
    const owner = (u.inPlay ? (CHAR.play.purchases || {})[u.category] : kitOf(u.category))
      || [];
    const host = owner[u.host];
    if (!host || u.entry === undefined) return false;
    const arr = host[u.list] = host[u.list] || [];
    arr.splice(Math.max(0, Math.min(arr.length, u.at)), 0, deepCopyEntry(u.entry));
    return true;
  },
  // Unpaid month changes: the counter, a chargen correction, the one-time
  // resync. No cash moved either way, so undo just puts the count back.
  lifestyle_adjust: u => {
    const ls = (CHAR.play.lifestyles || []).find(x => x.name === u.name);
    if (!ls) return false;
    ls.months = Math.max(0, +u.from || 0);
    return true;
  },
};
async function undoCashSpend(entry) {
  const log = CHAR.play.cash_log;
  const idx = log.indexOf(entry);
  const handler = entry && entry.undo && CASH_UNDO[entry.undo.kind];
  if (idx < 0 || !handler) return;
  // A zero-delta entry moved no money (an unpaid lifestyle adjustment), so
  // promising a refund would be nonsense.
  if (!confirm(`Undo "${entry.label}"?\n\n`
    + (entry.delta
        ? `It is removed and ${fmt(-entry.delta)} refunded in full.`
        : "It is removed and the previous value restored. No cash moved."))) return;
  if (!handler(entry.undo)) {
    alert(`"${entry.label}" isn't there any more — it was already removed.\n\n`
      + "The ledger entry stays. Use Adjust if the refund is still owed.");
    return;
  }
  CHAR.play.cash -= entry.delta;   // delta is negative, so this refunds it
  log.splice(idx, 1);
  await playChangedRecalc();
}

/* ================================================================ the kit
 *
 * `play.kit` is play's own copy of what the character walked out of creation
 * with. Everything the play sheet edits — worn flags, fitted mods, quantities,
 * α-grades, sales, losses, reordering — edits the kit; the chargen arrays are
 * never written to after Finalize. That single rule is what keeps the creation
 * budget stable, lets Back to Chargen show the character exactly as built, and
 * makes Revert a one-liner: rebuild the kit from chargen.
 *
 * It replaced three narrower mechanisms (`disposed`, `fitted_mods` /
 * `disposed_mods`, `unit_overrides`), each of which patched one path by which
 * play could reach into the creation record. */
function kitFromChargen() {
  const kit = {};
  for (const category of RULES.KIT_CATEGORIES)
    kit[category] = deepCopyEntry(CHAR[category] || []);
  return kit;
}
function kitOf(category) {
  const kit = CHAR.play.kit;
  if (!kit) return CHAR[category] || [];        // pre-Finalize / pre-migration
  return (kit[category] = kit[category] || []);
}

/* Build the kit if there isn't one, and migrate a character saved before it
 * existed. The legacy replay lives in the engine, so migration is just "ask the
 * engine what this character currently has, and keep that". */
function ensureKit() {
  const play = CHAR.play;
  if (play.kit) return play.kit;
  if (!CHAR.finalized) return null;             // nothing to copy yet
  const legacy = play.disposed || play.fitted_mods || play.disposed_mods
    || play.unit_overrides;
  const hadLegacyEdits = legacy && (
    Object.values(play.disposed || {}).some(v => (v || []).length)
    || (play.fitted_mods || []).length || (play.disposed_mods || []).length
    || Object.keys(play.unit_overrides || {}).length);
  if (hadLegacyEdits) {
    // Replay the old records through the engine, then keep the result minus
    // anything bought in play (which stays in play.purchases where it lives).
    const resolved = RULES.applyPlayAdvances(JSON.parse(JSON.stringify(CHAR)));
    play.kit = {};
    for (const category of RULES.KIT_CATEGORIES) {
      const bought = ((play.purchases || {})[category] || []).length;
      const all = resolved[category] || [];
      play.kit[category] = deepCopyEntry(bought ? all.slice(0, all.length - bought) : all);
    }
  } else {
    play.kit = kitFromChargen();
  }
  play.kit_baseline = kitFromChargen();
  // The old records are now folded into the kit; leaving them would apply twice.
  play.disposed = {}; play.fitted_mods = []; play.disposed_mods = [];
  play.unit_overrides = {};
  return play.kit;
}

/* Characters built before the Hacking program existed carry a `hacking_rating`
 * scalar instead, plus any levels bought in play. Grant the equivalent program
 * once and slot it into every deck they own.
 *
 * Cost-neutral by construction: they paid ㄓ5,000 per level and "Hacking N"
 * costs ㄓ5,000 × N, so the budget doesn't move. The same copy goes in every
 * deck because that is what a character-wide rating meant — one program, moved
 * between decks as needed.
 *
 * Runs against the chargen record (which is what the old scalar priced) and
 * against the kit, so the play sheet and the build agree. */
function migrateHackingProgram() {
  const play = CHAR.play;
  const legacy = Math.max(0, Math.min(6,
    (+CHAR.hacking_rating || 0) + (+(play.purchases || {}).hacking_levels || 0)));
  if (!CHAR.hacking_rating && !((play.purchases || {}).hacking_levels)) return;
  const program = legacy ? `Hacking ${legacy}` : "";
  const grant = (programs, decks) => {
    if (program && !programs.includes(program)) programs.push(program);
    for (const d of decks) if (d && !d.hacking) d.hacking = program;
  };
  grant(CHAR.programs = CHAR.programs || [], CHAR.decks || []);
  if (play.kit) grant(play.kit.programs = play.kit.programs || [], play.kit.decks || []);
  CHAR.hacking_rating = 0;
  if (play.purchases) play.purchases.hacking_levels = 0;
  if (program && play.cash_log) {
    logCash(`Hacking rating ${legacy} became ${program}, slotted into `
      + `${(CHAR.decks || []).length || (play.kit ? (play.kit.decks || []).length : 0)} deck(s)`, 0);
  }
}

/* What creation cost, priced from the chargen record — never from the kit, so
 * it answers "what did this build cost" rather than "what is this character
 * carrying". Taken at every Finalize, and once on load for a character
 * finalized before the freeze existed. */
function snapshotCreationBudget() {
  const c = JSON.parse(JSON.stringify(CHAR));
  c.finalized = false;
  const b = RULES.calculate(c).budget;
  return { starting_cash: b.starting_cash, categories: b.categories,
           spent: b.spent, remaining: b.remaining };
}
function ensureCreationBudget() {
  const play = CHAR.play;
  if (play.creation_budget || !CHAR.finalized) return;
  play.creation_budget = snapshotCreationBudget();
}

/* An entry's identity for reconciling: its name. Sublist members (weapon mods,
 * armor extras) are sometimes bare strings and sometimes {name}, so both shapes
 * answer here. */
const entryLabel = e => (e && typeof e === "object") ? (e.name || "") : String(e);

/* Carry a chargen edit to an item the character ALREADY owned onto play's copy
 * of it. `from` is the chargen entry now, `base` what chargen said at the last
 * sync, `into` play's copy. Only fields the owner actually changed move, so
 * anything play did to the same item survives:
 *
 *   - list fields (a weapon's mods, an armor piece's extras) apply the chargen
 *     DELTA — a mod fitted in play isn't wiped by a chargen edit elsewhere on
 *     the same gun;
 *   - scalar fields (smart, style, material, qty, a focus link) are written
 *     across only when they differ from the baseline. An untouched field means
 *     play's value stands, which is what keeps a "worn"/"equipped" toggle made
 *     at the table from snapping back after a trip through chargen.
 */
function mergeChargenEdits(from, base, into, note) {
  if (!from || typeof from !== "object" || !into || typeof into !== "object") return;
  const was = (base && typeof base === "object") ? base : {};
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const [key, value] of Object.entries(from)) {
    if (key === "name") continue;
    if (Array.isArray(value)) {
      const wasList = Array.isArray(was[key]) ? was[key] : [];
      if (same(value, wasList)) continue;
      const target = Array.isArray(into[key]) ? into[key] : (into[key] = []);
      const tally = list => list.reduce((m, e) =>
        m.set(entryLabel(e), (m.get(entryLabel(e)) || 0) + 1), new Map());
      const nowCount = tally(value), wasCount = tally(wasList);
      for (const [member, n] of nowCount) {
        for (let k = (wasCount.get(member) || 0); k < n; k++) {
          target.push(deepCopyEntry(value.find(e => entryLabel(e) === member)));
          note(`+${member}`);
        }
      }
      for (const [member, n] of wasCount) {
        for (let k = (nowCount.get(member) || 0); k < n; k++) {
          const at = target.findIndex(e => entryLabel(e) === member);
          if (at >= 0) { target.splice(at, 1); note(`−${member}`); }
        }
      }
    } else if (!same(value, was[key])) {
      into[key] = deepCopyEntry(value);
      note(`${key} ${value === "" ? "cleared" : value}`);
    }
  }
}

/* Re-finalize. The kit is play's, so an unrelated trip through chargen must not
 * disturb it — but a genuine edit to the BUILD should carry across, the same
 * ruling that governs lifestyle months. `kit_baseline` is what chargen said at
 * the last sync, so anything that differs from it now is an owner edit:
 * appended entries are added to the kit, removed ones are taken out of it,
 * edits to an item that's still there are merged onto play's copy of it, and
 * everything the player did in play is left alone.
 *
 * That last case is easy to miss: matching by name alone, fitting Bling to a
 * rifle you already owned changes nothing about the name, so before
 * mergeChargenEdits the mod stayed in chargen and never reached the sheet or
 * the markdown export. */
function reconcileKit() {
  const play = CHAR.play;
  if (!play.kit) { ensureKit(); return; }
  const baseline = play.kit_baseline || {};
  const notes = [];
  for (const category of RULES.KIT_CATEGORIES) {
    const now = CHAR[category] || [];
    const was = baseline[category] || [];
    const kit = play.kit[category] = play.kit[category] || [];
    const label = entryLabel;
    const tally = list => list.reduce((m, e) => m.set(label(e), (m.get(label(e)) || 0) + 1), new Map());
    const nowCount = tally(now), wasCount = tally(was);
    for (const [name, n] of nowCount) {                 // added in chargen
      // Copy the k-th same-named entry, not the first: buying a SECOND M31 must
      // hand play a bare one, not a clone of the first gun's mods and flags.
      const ones = now.filter(e => label(e) === name);
      for (let k = (wasCount.get(name) || 0); k < n; k++) {
        kit.push(deepCopyEntry(ones[k]));
        notes.push(`+${name}`);
      }
    }
    for (const [name, n] of wasCount) {                 // removed in chargen
      for (let k = (nowCount.get(name) || 0); k < n; k++) {
        const at = kit.findIndex(e => label(e) === name);
        if (at >= 0) { kit.splice(at, 1); notes.push(`−${name}`); }
      }
    }
    // Still-owned items, reconfigured in chargen. Same-named copies pair up in
    // order (the k-th "Armored Coat" here is the k-th one there). Only the ones
    // that existed at the baseline are merged — anything added above that count
    // was just deep-copied into the kit and has nothing to reconcile.
    for (const name of nowCount.keys()) {
      const nowOnes = now.filter(e => label(e) === name);
      const wasOnes = was.filter(e => label(e) === name);
      const kitOnes = kit.filter(e => label(e) === name);
      for (let k = 0; k < Math.min(nowOnes.length, kitOnes.length, wasOnes.length); k++) {
        mergeChargenEdits(nowOnes[k], wasOnes[k], kitOnes[k],
          detail => notes.push(`${name}: ${detail}`));
      }
    }
  }
  play.kit_baseline = kitFromChargen();
  if (notes.length)
    logCash(`Chargen build edited: ${notes.slice(0, 6).join(", ")}`
      + (notes.length > 6 ? ` +${notes.length - 6} more` : ""), 0);
}

/* ---------------------------------------------- disposing of kit during play
 *
 * Parting with something in play is either a SALE (cash back at whatever the
 * fence pays) or a LOSS (destroyed, confiscated, left in a burning car).
 * Both land in the Activity ledger; only the first moves money.
 *
 * Where the item goes depends on which side of Finalize it came from, and this
 * is the other half of the JC-024 line:
 *
 *   - Bought in play  → spliced out of play.purchases, where it lived.
 *   - Chargen kit     → the chargen array is NOT touched. The index is recorded
 *                       in play.disposed and the engine filters it out of the
 *                       finalized sheet. The creation budget still counts it —
 *                       it was bought with creation cash and that money is
 *                       spent — so Back to Chargen shows the character exactly
 *                       as built, and re-finalizing takes the item away again.
 *                       Revert drops the whole play layer, so it comes back.
 *
 * Before this, every ✕ spliced the owning array. On a chargen item that handed
 * its cost back to the creation budget: sell a weapon in play, go Back to
 * Chargen, and the money was there to spend again.
 */
const DEFAULT_RESALE_PCT = 50;
// The chargen arrays a disposal can be recorded against.
const DISPOSABLE_CATEGORIES = ["weapons", "armor", "gear", "augments", "decks",
  "programs", "rigs", "drones", "vehicles"];

/* Sell / lose / cancel. Resolves to null (cancelled), { sold: false }, or
 * { sold: true, amount }. The percentage is a starting point, not a rule — the
 * amount is editable, because what a fence pays is a table's call, not ours.
 * The last percentage used sticks for the session, so a table running 25%
 * doesn't retype it on every sale. */
let lastResalePct = DEFAULT_RESALE_PCT;
function promptDisposal(name, value) {
  return new Promise(resolve => {
    const base = Math.max(0, Math.round(+value || 0));
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = val => {
      document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(val);
    };
    const onKey = e => { if (e.key === "Escape") done(null); };

    const amountOf = pct => Math.round(base * (Math.max(0, Math.min(100, pct)) / 100));
    const pctInput = el("input", { type: "number", min: "0", max: "100", step: "5",
      value: String(lastResalePct), style: "width:74px" });
    const amtInput = el("input", { type: "number", min: "0", step: "1",
      value: String(amountOf(lastResalePct)), style: "width:110px" });
    const sellBtn = el("button", { class: "btn-add" }, "Sell");
    const syncFromPct = () => { amtInput.value = String(amountOf(+pctInput.value || 0)); };
    pctInput.addEventListener("input", syncFromPct);

    sellBtn.onclick = () => {
      lastResalePct = Math.max(0, Math.min(100, +pctInput.value || 0));
      done({ sold: true, amount: Math.max(0, Math.round(+amtInput.value || 0)) });
    };

    const modal = el("div", { class: "card mount-modal", style: "max-width:420px" },
      el("h3", {}, `Part with ${name}?`),
      el("p", { class: "hint" },
        base ? `Bought for ${fmt(base)}. Sell it on, or write it off as lost.`
             : "No recorded value for this item — set the sale price yourself, "
               + "or write it off as lost."),
      el("div", { class: "stat-line" },
        el("span", {}, "Sell at "), pctInput, el("span", {}, "% "),
        el("span", { class: "sub" }, "→ "), amtInput,
        el("span", { class: "sub" }, ` ${RULES.currencyName()}`)),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
        sellBtn,
        el("button", { class: "btn", onclick: () => done({ sold: false }) }, "Lost / discarded"),
        el("button", { class: "btn ghost", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    amtInput.focus(); amtInput.select();
  });
}

function deepCopyEntry(entry) {
  return (entry && typeof entry === "object") ? JSON.parse(JSON.stringify(entry)) : entry;
}
const sublistName = m => (m && typeof m === "object") ? m.name : m;

/* The one entry point every ✕ on the play sheet goes through. `arr` is the
 * array the row is backed by — the kit or play.purchases, both play's — so
 * parting with something is now just a splice. Returns true when it happened. */
async function disposeOfItem({ category, arr, index, inPlay, name, value }) {
  const result = await promptDisposal(name, value);
  if (!result) return false;
  const entry = deepCopyEntry(arr[index]);
  arr.splice(index, 1);
  logCash(`${result.sold ? "Sold" : "Lost"} ${name}`, result.sold ? result.amount : 0,
    { kind: "restore_item", category, inPlay, at: index, entry });
  await playChangedRecalc();
  return true;
}

/* Sublists inside an owned item: weapon mods, armor extras, deck/rig/unit mods,
 * mounted augments, a drone's weapons. The host is play's own copy either way
 * now, so these are plain array operations — no records, no replay, no
 * index bookkeeping. The shape is kept so call sites read the same. */
function sublistOf(entry, list) {
  const arr = entry.ref[list] = entry.ref[list] || [];
  return { items: arr, add: v => arr.push(v), removeAt: i => { arr.splice(i, 1); } };
}

/* Pulling a mod off a drone or vehicle. Unit mods point at the unit's weapons
 * by index, so removeUnitWeapon renumbers them; restoring one out of a
 * renumbered set isn't a safe single step, hence no Undo button here. */
async function disposeOfUnitMod(entry, modIndex, name, hostName, value) {
  const result = await promptDisposal(name, value);
  if (!result) return false;
  entry.ref.mods.splice(modIndex, 1);
  logCash(`${result.sold ? "Sold" : "Lost"} ${name} (off ${hostName})`,
    result.sold ? result.amount : 0);
  await playChangedRecalc();
  return true;
}

/* Pulling something off an item: same dialog, same ledger, same undo as
 * parting with the item itself. Returns true when it went ahead. */
async function disposeOfMod({ entry, list, index, name, value, hostName }) {
  const result = await promptDisposal(name, value);
  if (!result) return false;
  const sub = sublistOf(entry, list);
  const removed = deepCopyEntry(sub.items[index]);
  sub.removeAt(index);
  logCash(`${result.sold ? "Sold" : "Lost"} ${name} (off ${hostName})`,
    result.sold ? result.amount : 0,
    { kind: "restore_mod", category: entry.category, inPlay: entry.inPlay,
      host: entry.i, list, at: index, entry: removed });
  await playChangedRecalc();
  return true;
}

function chargenLifestyles() {
  return (CHAR.lifestyles && CHAR.lifestyles.length)
    ? CHAR.lifestyles
    : (CHAR.lifestyle && CHAR.lifestyle.name ? [CHAR.lifestyle] : []);
}

/* Snapshot the chargen months so a later sync can tell "the player burned a
 * month" from "someone corrected the purchase in chargen". */
function stampLifestyleBaseline(play) {
  const baseline = play.lifestyles_baseline = play.lifestyles_baseline || {};
  for (const ls of chargenLifestyles()) baseline[ls.name] = Math.max(0, +ls.months || 0);
  play.lifestyles_reconciled = true;
  return baseline;
}

function seedLifestyles() {
  const play = CHAR.play;
  if (play.lifestyles_seeded) return;
  chargenLifestyles().forEach((ls, i) =>
    play.lifestyles.push({ name: ls.name, months: ls.months || 0, active: i === 0 }));
  play.lifestyles_seeded = true;
  stampLifestyleBaseline(play);
}

/* Merge chargen (prepaid) lifestyles into play at finalize. Adds any not present
 * by name, and — because chargen months are BOUGHT with creation cash — carries
 * a corrected month count across to the play balance too. Runs only at an
 * explicit finalize (not on every sheet view), so it never resurrects a
 * lifestyle the player removed during play.
 *
 * Months are only overwritten when the chargen record itself changed since the
 * last sync. A re-finalize that didn't touch lifestyles leaves the play balance
 * alone, so months burned in play aren't handed back for an unrelated edit. */
function syncChargenLifestyles() {
  const play = CHAR.play;
  play.lifestyles = play.lifestyles || [];
  const baseline = play.lifestyles_baseline = play.lifestyles_baseline || {};
  for (const ls of chargenLifestyles()) {
    const months = Math.max(0, +ls.months || 0);
    const existing = play.lifestyles.find(p => p.name === ls.name);
    if (!existing) {
      play.lifestyles.push({ name: ls.name, months, active: play.lifestyles.length === 0 });
    } else if (baseline[ls.name] !== months && existing.months !== months) {
      logCash(`${ls.name} lifestyle corrected in chargen: `
        + `${existing.months} → ${months} mo`, 0,
        { kind: "lifestyle_adjust", name: ls.name, from: existing.months });
      existing.months = months;
    }
  }
  play.lifestyles_seeded = true;
  stampLifestyleBaseline(play);
}

/* One-time repair for characters finalized before 2026-08-05.
 *
 * play.lifestyles was seeded from chargen once and then never reconciled: both
 * copiers above were insert-only by name, so correcting the months in chargen
 * left the play balance stranded at its old value with no way to fix it short
 * of a full Revert. Those characters carry no baseline, which is how we spot
 * them. Chargen months are paid for out of creation cash, so the chargen record
 * wins and the play balance is reset to it.
 *
 * This can hand back months already burned, because burning one was never
 * recorded anywhere — there is no evidence to tell the two apart. Every change
 * is written to the Activity ledger so it is visible and undoable, and it
 * happens once: from here on the baseline exists and month changes are logged
 * as they happen. */
function reconcileLifestyles() {
  const play = CHAR.play;
  if (!play.lifestyles_seeded || play.lifestyles_reconciled) return;
  for (const ls of chargenLifestyles()) {
    const months = Math.max(0, +ls.months || 0);
    const existing = (play.lifestyles || []).find(p => p.name === ls.name);
    if (!existing || existing.months === months) continue;
    logCash(`${ls.name} lifestyle resynced to the chargen purchase: `
      + `${existing.months} → ${months} mo`, 0,
      { kind: "lifestyle_adjust", name: ls.name, from: existing.months });
    existing.months = months;
  }
  stampLifestyleBaseline(play);
}

function enterSheet() {
  ensurePlay();
  seedLifestyles();
  sheetTab = "overview";
  expandedPool = null;
  sheetStickyScrolled = false;   // entering always lands at the top
  $("#app").hidden = true;
  $("#sheet").hidden = false;
  renderSheet();
  window.scrollTo(0, 0);
}
function exitSheet() {
  if (sheetHeadObserver) { sheetHeadObserver.disconnect(); sheetHeadObserver = null; }
  sheetStickyScrolled = false;
  $("#sheet").hidden = true;
  $("#app").hidden = false;
}

/* Reset the play layer back to how it looked right after Finalize.
 * No snapshot needed: the chargen record (attributes, skills, gear, decks…)
 * is never mutated during play — advancement and purchases live in CHAR.play
 * — so reverting is just rebuilding CHAR.play, keeping only the original
 * starting-cash roll. */
async function revertToChargenEnd() {
  const play = CHAR.play;
  if (!confirm("Revert this character to their state at the end of character generation?\n\n"
    + "This permanently erases everything gained in play:\n"
    + `  • Kismet (${play.kismet} available, ${play.kismet_earned} lifetime) and all advances\n`
    + "  • Everything bought in play (weapons, armor, gear, augments, powers, spells, Hacking levels)\n"
    + `  • ${RULES.currencyName()} beyond the original starting roll (back to ${fmt(play.starting_cash || 0)})\n`
    + "  • Damage, initiative, effects, modifiers, ledgers, and notes\n\n"
    + "The chargen build itself (attributes, skills, purchased gear) is untouched."))
    return;
  const keepRolled = play.cash_rolled;
  const keepStart = play.starting_cash
    || (play.cash_log.find(e => e.label.startsWith("Starting cash roll")) || {}).delta || 0;
  const rollEntry = play.cash_log.find(e => e.label.startsWith("Starting cash roll"));
  const keepGhost = play.ghost_rating;   // rolled once at first finalize — never re-rolled
  CHAR.play = {};
  ensurePlay();
  CHAR.play.cash_rolled = keepRolled;
  CHAR.play.starting_cash = keepStart;
  CHAR.play.cash = keepStart;
  if (rollEntry) CHAR.play.cash_log = [rollEntry];
  if (keepGhost) CHAR.play.ghost_rating = keepGhost;
  // A fresh copy of the build IS the revert: worn flags, fitted mods,
  // quantities and everything else come back exactly as chargen has them. The
  // old armor_worn snapshot existed only because play used to edit the chargen
  // armor in place; there is nothing left to snapshot.
  CHAR.play.kit = kitFromChargen();
  CHAR.play.kit_baseline = kitFromChargen();
  seedLifestyles();
  await playChangedRecalc();
  alert("Character reverted to their post-chargen state.");
}

/* auto-generated dossier notes that don't fit the tab structure */
function moveSpecial() {   // CALC.combat.move_special is a list of special-movement notes
  const v = CALC.combat.move_special;
  return (Array.isArray(v) ? v.join(" · ") : String(v || "")).trim();
}

function dossierNotes() {
  const notes = [];
  if (CHAR.heritage.type === "Replicant")
    notes.push("Replicants are ILLEGAL and are hunted by government agents. Exposure means retirement squads — keep a low profile.");
  if (CALC.zoetics.magic_offline)
    notes.push(`MAGIC OFFLINE: ZP is ${CALC.zoetics.zp_remaining} — cyber ZR and Amp spending have reduced Zoetic Potential to 0 or below. Spells, Amps and Summoning are unavailable; only Rituals remain.`);
  else if (CALC.zoetics.amp_offline)
    notes.push(`AMP POWERS OFFLINE: ZP is ${CALC.zoetics.zp_remaining} — Amp ZP spent plus carried ZR exceeds your Zoetic Potential. Shed ZR or lose the powers.`);
  for (const msg of CALC.zoetics.mount_errors || []) notes.push(msg);
  if (moveSpecial()) notes.push("Movement: " + moveSpecial());
  if ((CHAR.heritage.features || []).length)
    notes.push(`Heritage features: ${CHAR.heritage.features.join(", ")}.`);
  return notes;
}

/* Worn armor stacked in one slot. Only ONE Outer and one Under piece is meant to
 * count, but every piece marked active adds to the Ballistic/Impact totals, so a
 * character wearing two coats silently reads several points too tough. The Gear
 * tab's Worn checkbox unticks the slot's other piece, and priceArmor already
 * pushes a warning -- but nothing created before that checkbox existed was
 * cleaned up, an import can arrive in any state, and CALC.warnings is only
 * rendered during chargen (the rail alerts), never on the play sheet.
 *
 * Recomputed from CALC.armor instead of matching the engine's warning text, so
 * the note can name the offending pieces. "Outer*" (Helmet) is deliberately not
 * counted -- it's a separate piece, matching priceArmor. */
function overArmoredSlots() {
  const bySlot = {};
  for (const a of CALC.armor || []) {
    if (!a.active || (a.Slot !== "Outer" && a.Slot !== "Under")) continue;
    (bySlot[a.Slot] ??= []).push(a.Armor);
  }
  return Object.entries(bySlot)
    .filter(([, names]) => names.length > 1)
    .map(([slot, names]) => ({ slot, names }));
}

/* Replicant remaining-lifespan tracker shown in the Overview warning area.
 * Rolled once as (1d6+1)×12 months, then ticked down by hand as play advances.
 * Returns null for non-Replicants. */
function replicantLifespanTracker() {
  if (CHAR.heritage.type !== "Replicant") return null;
  const play = CHAR.play;
  if (play.replicant_lifespan_months == null) {
    play.replicant_lifespan_months = (Math.floor(Math.random() * 6) + 1 + 1) * 12;   // (1d6+1)×12
    schedulePlaySave();
  }
  return el("div", { class: "sh-callout warn sh-lifespan" }, "⏳ ",
    miniCounter("Remaining Lifespan (Months)",
      () => play.replicant_lifespan_months || 0,
      v => { play.replicant_lifespan_months = v; }, 0, 9999));
}

/* ------------------------------------------------ shell */
function sheetTabList() {
  // Magic (everyone can learn rituals), Decking and Rigging are always shown so
  // a character can pick up a deck/rig/drone/vehicle in play even if they had
  // none at chargen.
  return [["overview", "Overview"], ["skills", "Skills"], ["kismet", "Kismet"],
    ["gear", "Gear"], ["augments", "Augments"], ["magic", "Magic"],
    ["decking", "Decking"], ["rigging", "Rigging"], ["actions", "Actions"],
    ["notes", "Notes"]];
}

function readonlyBanner() {
  const tab = activeTabObj();
  const who = (tab && tab.owner) ? `${tab.owner}'s` : "a shared";
  return el("div", { class: "sh-readonly-banner" },
    el("span", { class: "sh-ro-label" }, `👁 Viewing ${who} character — read only`),
    el("span", { class: "sh-ro-actions" },
      el("button", { class: "btn small good", onclick: saveReadonlyCopy }, "Save a copy to my account"),
      el("button", { class: "btn small ghost", onclick: () => closeTab(WORKSPACE.active) }, "Close")));
}

/* Reference tables (spirit benefits, rituals, the action reference) are wider
 * than a phone viewport and used to push the whole page sideways, so the sheet
 * scrolled horizontally instead of the table. Give each its own scroll box.
 * Done centrally rather than at the ~20 el("table") call sites; the wrapper is
 * inert when the table already fits, and no CSS selector depends on a table's
 * parent. */
function wrapScrollableTables(root) {
  for (const t of root.querySelectorAll("table")) {
    if (t.parentElement && t.parentElement.classList.contains("sh-tablewrap")) continue;
    const wrap = el("div", { class: "sh-tablewrap" });
    t.replaceWith(wrap);
    wrap.append(t);
  }
}

function renderSheet() {
  const root = $("#sheet");
  root.innerHTML = "";
  const ro = !!(typeof activeTabObj === "function" && activeTabObj() && activeTabObj().readonly);
  document.body.classList.toggle("sheet-readonly", ro);
  if (ro) root.append(readonlyBanner());
  const head = sheetHeader();
  const bar = sheetStickyBar();
  root.append(head, bar);
  const body = el("div", { class: "sheet-body" });
  ({ overview: shOverview, skills: shSkills, kismet: shKismet, gear: shGear,
     augments: shAugments, magic: shMagic, decking: shDecking,
     rigging: shRigging, actions: shActions, notes: shNotes })[sheetTab](body);
  wrapScrollableTables(body);
  root.append(body);
  root.append(rollerOverlay());
  root.append(scrollTopFab());
  // The full header scrolls away normally; once it leaves the viewport the
  // sticky bar grows a compact summary strip (pools / ZP / cash). The DOM is
  // rebuilt every render, so the observer is re-attached each time. The bar's
  // live height is published as --sh-sticky-h so nested sticky elements (the
  // gear-tab jump submenu) can park directly beneath it.
  const publishBarHeight = () => document.documentElement.style
    .setProperty("--sh-sticky-h", bar.offsetHeight + "px");
  publishBarHeight();
  if (sheetHeadObserver) sheetHeadObserver.disconnect();
  // The workspace strip is a fixed bar of height --ws-h at the very top; the
  // sheet's sticky bar parks just below it, so the header counts as "gone" once
  // it slips under both.
  const wsH = parseInt(getComputedStyle(document.documentElement)
    .getPropertyValue("--ws-h"), 10) || 0;
  sheetHeadObserver = new IntersectionObserver(([entry]) => {
    sheetStickyScrolled = !entry.isIntersecting;
    bar.classList.toggle("scrolled", sheetStickyScrolled);
    // The back-to-top FAB rides the same threshold as the shrunk header.
    const fab = document.getElementById("sh-scrolltop");
    if (fab) fab.classList.toggle("visible", sheetStickyScrolled);
    publishBarHeight();
  }, { rootMargin: `-${48 + wsH}px 0px 0px 0px` });
  sheetHeadObserver.observe(head);
}

/* Smoothly scroll the sheet back to the top. Shared by the back-to-top FAB and
 * the compact sticky strip (click any non-interactive part of it). */
function scrollSheetToTop() { window.scrollTo({ top: 0, behavior: "smooth" }); }

/* Floating "back to top" button, lower-right, just left of the die-roller FAB.
 * Hidden until the header shrinks away; the head observer toggles .visible. */
function scrollTopFab() {
  return el("button", {
    id: "sh-scrolltop",
    class: "sh-scrolltop" + (sheetStickyScrolled ? " visible" : ""),
    title: "Back to top", "aria-label": "Back to top",
    onclick: scrollSheetToTop,
  }, "↑");
}

function counterBtn(label, fn, cls) {
  return el("button", { class: "btn " + (cls || ""), onclick: fn }, label);
}

/* ------------------------------------------------ die roller */
/* Floating d6 success roller: pick a pool size, roll, every 4-6 is a Success.
 * Any die can be selected and re-rolled, but each die only once per roll.
 * State lives here (not in the DOM) so it survives the full rebuilds of
 * renderSheet(); interactions re-render only the overlay itself.
 *
 * Two modes. "free" is a bare pool roll. "initiative" preloads the Focus-pool
 * dice and carries Reaction as a flat bonus added to the successes, writing
 * the total straight into the sheet's Initiative field on every roll and
 * re-roll (see rollerApply). */
const ROLLER_MAX_DICE = 30;
const rollerD6 = () => 1 + Math.floor(Math.random() * 6);
/* dice: {value, selected, rerolled}
 * `count`     — the LIMIT dice: skill (or skill ± specialization). These are
 *               the dice that come out of a pool, and the only thing the main
 *               ± moves. Shown on its own, the way a weapon chip reads "3d".
 * `bonus`     — flat number added to successes (Initiative's Reaction).
 * `bonusDice` — free dice the roll came WITH: a weapon's Accuracy and firing
 *               mode, a skill's bonus dice. Inherent to the test, so they stay
 *               put across repeat rolls of it.
 * `bonusAdded` — free dice added by hand for this roll: point-blank, good
 *               light, a spirit leaning in. Situational, so they clear once
 *               thrown. Both are rolled and neither costs pool; the Bonus dice
 *               row shows the two together, since what you want to see there is
 *               how many free dice are going in.
 * Dice thrown = count + bonusDice + bonusAdded. Pool spent = count.
 * `pool`      — the pool a roll draws from, "" for none. Sticky between rolls,
 *               because a run of Finesse tests is the normal case. */
const rollerState = { open: false, count: 6, dice: [], bonus: 0, bonusDice: 0,
                      bonusAdded: 0, mode: "free", pool: "", spent: null, penalty: 0 };
/* Every die in the roll that costs no pool, before penalties. */
const rollerFreeDice = () => (rollerState.bonusDice || 0) + (rollerState.bonusAdded || 0);

/* What actually gets thrown once the wound penalty is taken off.
 *
 * The combat sequence is explicit about the order: penalty dice cancel bonus
 * dice first, and only "once the bonus dice are eliminated" do they lower the
 * limit. So a −2 wound on a roll with 5 bonus dice costs no limit at all, and a
 * −2 on a roll with none takes 2 off the limit — and with it, 2 off the pool,
 * since the pool only ever pays for limit dice. */
function rollerEffective() {
  const st = rollerState;
  const penalty = Math.max(0, st.penalty || 0);
  const free = rollerFreeDice();
  const bonus = Math.max(0, free - penalty);
  const limit = Math.max(0, Math.max(0, st.count) - Math.max(0, penalty - free));
  return { penalty, free, bonus, limit, total: bonus + limit,
           bonusLost: free - bonus, limitLost: Math.max(0, st.count) - limit };
}
const rollerTotalDice = () => rollerEffective().total;

function rollerRefresh() {
  const cur = $("#die-roller");
  if (cur) cur.replaceWith(rollerOverlay());
}

/* The wound penalty the tracks currently impose: every 3 boxes marked on either
 * track is −1 die on tasks, cumulative, doubled by a Reaction Enhancer and
 * negated outright by a Pain Nullifier. `dice` is signed (−2), `size` is the
 * count of penalty dice (2). Shared by the Condition card and the die roller,
 * so what the sheet says you're suffering is what the roller takes off. */
function woundPenalty() {
  const play = CHAR.play || {};
  const raw = -(Math.floor((play.physical_damage || 0) / 3) + Math.floor((play.stun_damage || 0) / 3));
  const negated = !!(CALC.combat || {}).wound_penalty_negated;
  const doubled = !!(CALC.combat || {}).wound_penalty_doubled;
  const dice = negated ? 0 : raw * (doubled ? 2 : 1);
  return { raw, negated, doubled, dice, size: Math.abs(dice) };
}

/* Initiative as shown on the sheet: Focus-pool dice + Reaction ("12d+8"). */
function sheetInitiative() {
  return CALC.initiative
    || { dice: CALC.pools.Focus, bonus: CALC.attributes.Reaction.final, notes: [] };
}

/* Open the roller loaded with a named test's dice — what every clickable dice
 * figure on the sheet calls. `dice` is the limit (skill, or skill + Accuracy on
 * a weapon) and `bonus` the bonus dice from firing mode, light, point-blank and
 * so on; both are dice you roll, so they add into one count. It stops at
 * loading them: penalty dice from range, cover and lighting are a table call,
 * and the ± steppers are right there to apply them before you roll. */
function openPoolRoller({ dice, bonus = 0, label, note, pool }) {
  Object.assign(rollerState, {
    open: true, mode: "pool", label: label || "", note: note || "",
    dice: [], bonus: 0, spent: null, bonusAdded: 0,
    // Skill dice in the count, bonus dice in the bonus row — the roller reads
    // the way the chip that opened it does.
    bonusDice: Math.max(0, Math.min(ROLLER_MAX_DICE, +bonus || 0)),
    count: Math.max(0, Math.min(ROLLER_MAX_DICE, +dice || 0)),
    // A test rolled off a skill knows which pool it draws from; keep the last
    // choice when the caller doesn't say.
    pool: pool !== undefined ? (pool || "") : rollerState.pool,
    // Wounds are a standing condition, not a situational modifier, so the
    // roller takes them off every test without being asked (issue #30).
    penalty: woundPenalty().size,
  });
  // A roll with nothing in it is no roll: a caller that preloads only bonus
  // dice (Soak, Dodge) starts at zero limit, but a bare one needs a die.
  if (rollerTotalDice() < 1 && !rollerFreeDice()) rollerState.count = Math.max(1, rollerState.count);
  rollerRefresh();
}

/* Take the roll's limit dice out of the chosen pool. Bonus dice are free — they
 * come from the firing mode or the light, not from you — so only the part of
 * the count that isn't bonus is spent. Returns what actually moved, which can
 * be short of the ask when the pool is nearly out. */
function rollerSpendPool() {
  const st = rollerState;
  if (!st.pool || st.mode === "initiative") return null;
  // A shared view can roll all it likes; it doesn't get to spend someone else's
  // pool, even transiently (nothing persists there, but the chip would move).
  if (activeTabObj() && activeTabObj().readonly) return null;
  // Only limit dice cost pool, and only the ones that survived the penalty.
  const want = rollerEffective().limit;
  if (!want) return null;
  const ps = poolState(st.pool);
  const spend = Math.min(want, ps.remaining);
  const result = { pool: st.pool, want, spend, left: ps.remaining - spend };
  if (spend > 0) ps.setUsed(ps.used + spend);   // persists and re-renders
  return result;
}

/* A dice figure you can click to load the roller. Wraps whatever the caller
 * already renders (a rating, a "(4d +1b)" chip) so the reading stays put and
 * only the affordance is added. */
function rollable(node, { dice, bonus = 0, label, note, title, pool }) {
  const total = Math.max(0, (+dice || 0) + (+bonus || 0));
  if (!total) return node;      // nothing to roll — leave it as plain text
  return el("button", {
    class: "sh-rollable", type: "button",
    title: (title || `Roll ${total}d6 — ${label}`)
      + (pool ? ` · costs ${dice} ${pool}` : ""),
    onclick: e => { e.stopPropagation(); openPoolRoller({ dice, bonus, label, note, pool }); },
  }, node);
}

/* Open the roller preloaded for an Initiative roll. */
function openInitiativeRoller() {
  const init = sheetInitiative();
  Object.assign(rollerState, {
    open: true, mode: "initiative", dice: [],
    count: Math.max(1, Math.min(ROLLER_MAX_DICE, init.dice || 1)),
    bonus: init.bonus || 0,
  });
  rollerRefresh();
}

/* In initiative mode, push successes + bonus into the play sheet's Initiative
 * field. The input is patched in place rather than via renderSheet() so the
 * open roller isn't torn down mid-interaction; the value is still persisted. */
function rollerApply() {
  if (rollerState.mode !== "initiative") return;
  const successes = rollerState.dice.filter(d => d.value >= 4).length;
  CHAR.play.initiative = successes + rollerState.bonus;
  schedulePlaySave();
  const input = $(".sh-init-input");
  if (input) input.value = String(CHAR.play.initiative);
}

function rollerOverlay() {
  const st = rollerState;
  const wrap = el("div", { id: "die-roller" });
  wrap.append(el("button", {
    class: "sh-roller-fab" + (st.open ? " open" : ""),
    title: st.open ? "Close die roller" : "Die roller",
    "aria-label": st.open ? "Close die roller" : "Open die roller",
    // The FAB always opens a plain pool roll; the Initiative card's own button
    // is what puts the roller into initiative mode.
    onclick: () => {
      if (!st.open && st.mode !== "free") {
        Object.assign(st, { mode: "free", bonus: 0, bonusDice: 0, bonusAdded: 0,
          dice: [], spent: null });
      }
      if (!st.open) st.penalty = woundPenalty().size;   // refresh: wounds change

      st.open = !st.open;
      rollerRefresh();
    },
  }, "⚄"));
  if (!st.open) return wrap;

  const successes = st.dice.filter(d => d.value >= 4).length;
  const selected = st.dice.filter(d => d.selected).length;
  // Room left for more dice of either kind — 30 is the whole roll, not each half.
  const headroom = () => ROLLER_MAX_DICE - rollerTotalDice();
  // The main ± moves the skill dice, which are exactly the dice a pool pays
  // for: trimming for penalty dice trims the cost and leaves the free dice be.
  const stepBtn = (delta, label) => el("button", {
    class: "sh-roller-step", title: delta < 0 ? "One skill die fewer" : "One skill die more",
    onclick: () => {
      const next = st.count + delta;
      st.count = Math.max(0, delta > 0 ? Math.min(next, st.count + Math.max(0, headroom())) : next);
      if (rollerTotalDice() < 1) st.count = 1;      // never roll nothing
      rollerRefresh();
    },
  }, label);

  const isInit = st.mode === "initiative";
  const isPool = st.mode === "pool";
  const panel = el("div", { class: "sh-roller" },
    el("div", { class: "sh-roller-head" },
      isInit ? "Initiative Roll" : (isPool && st.label) ? st.label : "Die Roller",
      el("button", { class: "sh-roller-close", title: "Close",
        onclick: () => { st.open = false; rollerRefresh(); } }, "✕")),
    el("div", { class: "sh-roller-controls" },
      stepBtn(-1, "–"),
      // Skill dice, then the free dice alongside them — the same "3d +2b"
      // shorthand the weapon chips use.
      (() => {
        const eff = rollerEffective();
        return el("span", { class: "sh-roller-count",
            title: `${eff.total}d6 thrown — ${eff.limit} skill`
              + (eff.bonus ? ` + ${eff.bonus} bonus` : "")
              + (eff.penalty ? ` · wound −${eff.penalty} already taken off` : "") },
          `${eff.limit}d6` + (eff.bonus ? ` +${eff.bonus}b` : "")
          + (st.bonus ? ` +${st.bonus}` : ""));
      })(),
      stepBtn(1, "+"),
      el("button", { class: "btn sh-roller-roll",
        // Wounds can take a small test to nothing. That's the rule, but it has
        // to read as "you can't attempt this" rather than as a broken button.
        ...(rollerTotalDice() < 1 ? { disabled: "1",
          title: "No dice left once the wound penalty is applied" } : {}),
        onclick: () => {
        if (rollerTotalDice() < 1) return;
        st.dice = Array.from({ length: rollerTotalDice() },
          () => ({ value: rollerD6(), selected: false, rerolled: false }));
        rollerApply();
        st.spent = rollerSpendPool();   // re-renders the sheet if a pool moved
        // Hand-added dice belong to the roll that was just made — point-blank
        // range, that light, that one spirit — so they come off with it and a
        // second roll of the same test doesn't inherit a situation that has
        // passed. The dice the test came WITH (Accuracy, firing mode) stay:
        // they're the weapon, not the moment.
        if (st.bonusAdded) {
          if (st.spent) st.spent.bonus = st.bonusAdded;
          st.bonusAdded = 0;
        }
        rollerRefresh();
      } }, "Roll")));

  // Pool selector: which pool the roll comes out of. Initiative doesn't spend
  // one, so it isn't offered there.
  if (!isInit) {
    const sel = el("select", { class: "sh-roller-pool",
      title: "Rolling spends this many dice from this pool (bonus dice are free)",
      onchange: e => { st.pool = e.target.value; rollerRefresh(); } },
      el("option", { value: "" }, "No pool"),
      ...POOL_ORDER.map(p => {
        const ps = poolState(p);
        return el("option", { value: p }, `${p} ${ps.remaining}/${ps.max}`);
      }));
    sel.value = st.pool || "";
    const eff = rollerEffective();
    const freeDice = rollerFreeDice();
    panel.append(el("div", { class: "sh-roller-poolrow" }, sel,
      el("span", { class: "sub" }, st.pool
        ? `−${eff.limit}d on roll${eff.bonus ? ` (${eff.bonus} bonus free)` : ""}`
        : "no pool spent")));
    // Wounds come off before anything else is decided, so they're stated here
    // rather than left for the player to subtract (issue #30). Cancelling bonus
    // dice first is the combat sequence's own order.
    if (eff.penalty)
      panel.append(el("div", { class: "sh-roller-wound" },
        `Wound −${eff.penalty}d applied`
        + (eff.bonusLost ? ` · ${eff.bonusLost} bonus ${eff.bonusLost === 1 ? "die" : "dice"} cancelled` : "")
        + (eff.limitLost ? ` · ${eff.limitLost} off the limit` : "")));

    // Bonus dice: thrown with the rest, but off the table's own ledger rather
    // than out of you — a firing mode, point-blank range, good light, a spirit
    // leaning in. The count above moves with them; the pool cost does not.
    // Stepping the main ± moves the limit dice, so the two controls between
    // them say "how many I'm putting in" and "how many I'm being given".
    // The row shows every free die going in — the ones the test came with and
    // the ones added here — because that's the number you check before rolling.
    // ± only ever adds or removes hand-added ones first; the built-in dice go
    // last, and come back when the roll is reloaded from its chip.
    const bonusStep = (delta, label, title) => el("button", {
      class: "sh-roller-step", title,
      onclick: () => {
        if (delta > 0) {
          if (headroom() > 0) st.bonusAdded = (st.bonusAdded || 0) + 1;
        } else if (st.bonusAdded > 0) {
          st.bonusAdded -= 1;
        } else if (st.bonusDice > 0 && rollerTotalDice() > 1) {
          st.bonusDice -= 1;               // trimming a built-in bonus die
        }
        rollerRefresh();
      },
    }, label);
    panel.append(el("div", { class: "sh-roller-bonusrow" },
      el("span", { class: "sub" }, "Bonus dice"),
      bonusStep(-1, "–", "One fewer free die"),
      el("span", { class: "sh-roller-bonuscount" }, String(freeDice)),
      bonusStep(1, "+", "One more die that costs no pool, for this roll only"),
      el("span", { class: "sub" },
        st.bonusAdded ? `${st.bonusAdded} added this roll` : "no pool cost")));
  }

  if (st.dice.length) {
    panel.append(el("div", { class: "sh-roller-dice" },
      ...st.dice.map(d => el("button", {
        class: "sh-roller-die" + (d.value >= 4 ? " hit" : "")
          + (d.selected ? " sel" : "") + (d.rerolled ? " spent" : ""),
        title: d.rerolled ? `${d.value} — already re-rolled`
          : `${d.value} — tap to ${d.selected ? "keep" : "select for re-roll"}`,
        onclick: () => { if (!d.rerolled) { d.selected = !d.selected; rollerRefresh(); } },
      }, String(d.value)))));
    panel.append(el("div", { class: "sh-roller-succ" },
      el("b", {}, String(successes)), ` Success${successes === 1 ? "" : "es"}`,
      // Initiative adds Reaction to the successes; show the arithmetic.
      st.bonus ? el("span", { class: "sh-roller-sum" }, ` + ${st.bonus} = `) : null,
      st.bonus ? el("b", { class: "sh-roller-total" }, String(successes + st.bonus)) : null,
      st.bonus && isInit ? el("span", { class: "sh-roller-sum" }, " Initiative") : null));
    panel.append(el("button", {
      class: "btn sh-roller-reroll", ...(selected ? {} : { disabled: 1 }),
      onclick: () => {
        for (const d of st.dice) {
          if (d.selected) { d.value = rollerD6(); d.rerolled = true; d.selected = false; }
        }
        rollerApply();
        rollerRefresh();
      },
    }, selected ? `Re-roll ${selected} selected` : "Re-roll selected"));
    // What the roll cost, said once, after it happens. A short pool spends what
    // it has rather than refusing the roll — the dice were already thrown.
    if (st.spent && st.spent.spend > 0)
      panel.append(el("div", { class: "sh-roller-spent" },
        `−${st.spent.spend} ${st.spent.pool}`
        + (st.spent.spend < st.spent.want
            ? ` — ${st.spent.want} needed, pool was short` : "")
        + ` · ${st.spent.left} left`
        + (st.spent.bonus ? ` · ${st.spent.bonus} bonus dice free, now cleared` : "")));
    else if (st.spent && st.spent.want)
      panel.append(el("div", { class: "sh-roller-spent" },
        `${st.spent.pool} is empty — nothing left to spend`));
    panel.append(el("div", { class: "sh-roller-hint" },
      "4–6 = Success. Tap dice to mark for re-roll — each die re-rolls once."
      + (isInit ? " The total is saved to your Initiative." : "")
      + (st.spent ? " Re-rolls cost no further pool." : "")));
  } else if (rollerTotalDice() < 1) {
    panel.append(el("div", { class: "sh-roller-hint", style: "color:var(--bad)" },
      `The wound penalty takes this test to nothing — there are no dice left to roll. `
      + "Add bonus dice, or heal."));
  } else {
    panel.append(el("div", { class: "sh-roller-hint" },
      isInit
        ? `Roll ${rollerTotalDice()}d6 — every 4–6 is a Success, plus ${st.bonus} Reaction.`
        : `Roll ${rollerTotalDice()}d6 — every 4–6 is a Success.`
          // What made up the count, and the reminder that penalties are yours
          // to apply: the sheet can't know the range or the lighting.
          + (isPool && st.note ? ` ${st.note}.` : "")
          + (isPool ? " Adjust with – / + for penalty dice." : "")));
  }
  wrap.append(panel);
  return wrap;
}

/* Effective ZP = max ZP minus Amp ZP spent minus carried ZR, any fraction
 * knocking off a whole point (5.6 spent on 6 ZP shows 0 / 6), floored at 0.
 * Maximum ZP is unchanged by spending — only ZP advances raise it. Shared by
 * the header meter and the compact sticky strip. */
function zpMeterValues() {
  const z = CALC.zoetics;
  // House rule: ZP remaining = base − cyber − amp (gear ZR is a casting penalty,
  // not a ZP cost) and may go negative. Classic: base − ceil(amp + all carried ZR).
  if (RULES.houseRule("zr") === "houserule")
    return { current: z.zp_remaining, max: z.zp };
  const spent = (z.amp_zp_spent || 0) + (z.zr_total || 0);
  return { current: Math.max(0, z.zp - Math.ceil(spent)), max: z.zp };
}

/* Public/Private badge shown next to the name when signed in and viewing your
 * own saved character. Click to toggle sharing. Hidden in local-only mode and
 * on read-only shared views (not yours to share). */
function sharingBadge() {
  if (!(typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled())) return null;
  if (activeTabObj() && activeTabObj().readonly) return null;
  if (!CHAR.name) return null;
  const pub = SYNC.isPublic(STORAGE.sanitizeName(CHAR.name));
  return el("button", {
    class: "sh-share-badge " + (pub ? "public" : "private"),
    title: pub ? "Public — visible to other members. Click to make private."
               : "Private. Click to share with other members.",
    onclick: async e => { e.stopPropagation(); await toggleSharing(); renderSheet(); },
  }, pub ? "🌐 Public" : "🔒 Private");
}

function sheetHeader() {
  const play = CHAR.play;
  const head = el("header", { class: "sheet-head" });

  const heritageLabel = CHAR.heritage.type
    + (CHAR.heritage.uplift_type ? ` (${CHAR.heritage.uplift_type})` : "");
  const activeLs = (play.lifestyles || []).find(l => l.active);
  const heritageAbilities = heritageAbilityLines();
  // Current-lifestyle dropdown: switches the active flag among the
  // lifestyles the character owns (same effect as the radio buttons on the
  // Gear tab's lifestyle card).
  const lsSelect = (play.lifestyles || []).length
    ? el("select", { class: "sh-tag-select",
        title: activeLs ? (LIFESTYLE_EFFECTS[activeLs.name] || "") : "Choose current lifestyle",
        onchange: e => {
          play.lifestyles.forEach(l => { l.active = l.name === e.target.value; });
          playChanged();
        } },
        ...(activeLs ? [] : [el("option", { value: "", selected: 1 }, "Lifestyle…")]),
        ...play.lifestyles.map(l => el("option",
          { value: l.name, ...(l.active ? { selected: 1 } : {}) },
          `${l.name} lifestyle · ${l.months || 0} mo`)))
    : null;
  const ident = el("div", { class: "sh-ident" },
    el("div", { class: "sh-ident-top" },
      // The ☰ menu now lives on the workspace tab strip (renderWorkspaceBar),
      // so it's reachable from both chargen and play — not just here.
      el("div", { class: "sh-name" }, CHAR.name || "Unnamed"),
      sharingBadge()),
    CHAR.player ? el("div", { class: "sh-player" }, CHAR.player) : null,
    el("div", { class: "sh-tags" },
      el("span", { class: "sh-tag" }, heritageLabel),
      el("span", { class: "sh-tag magic" }, CALC.magic.type),
      lsSelect),
    activeLs && LIFESTYLE_EFFECTS[activeLs.name]
      ? el("div", { class: "sh-ls-effect" }, LIFESTYLE_EFFECTS[activeLs.name]) : null,
    heritageAbilities.length
      ? el("div", { class: "sh-heritage-abilities" },
          el("b", {}, "Abilities: "), heritageAbilities.join(" · ")) : null);

  // interactive pool tiles live up here — pools matter more than attributes
  const pools = el("div", { class: "sh-head-pools" },
    ...POOL_ORDER.map(headerPoolTile), kismetPoolTile());

  const z = CALC.zoetics;
  const { current: zpCurrent } = zpMeterValues();
  const houseZr = RULES.houseRule("zr") === "houserule";
  const castPen = Math.floor(z.gear_zr);
  const zpTitle = houseZr
    ? `Zoetic Potential ${z.zp}`
        + (z.augment_zr > 0 ? ` − Cyber ZP spent ${z.augment_zr}` : "")
        + (z.amp_zp_spent > 0 ? ` − Amp ZP spent ${z.amp_zp_spent}` : "")
    : `Zoetic Potential ${z.zp}`
        + (z.amp_zp_spent > 0 ? ` − Amp ZP spent ${z.amp_zp_spent}` : "")
        + ` − carried ZR ${z.zr_total} (fractions round up)`;
  const zrMeter = houseZr
    ? el("div", { class: "sh-meter zoetic",
        title: `Gear/weapon ZR ${z.gear_zr}${castPen > 0 ? ` — −${castPen}d on casting rolls` : ""}` },
        el("div", { class: "k" }, "Gear ZR"),
        el("div", { class: "v" }, String(z.gear_zr)))
    : el("div", { class: "sh-meter zoetic",
        title: `Augment ZR ${z.augment_zr} + gear ZR ${z.gear_zr}`
          + (CHAR.heritage.type === "Synthetic" ? " (Synthetic: augment ZR untracked)" : "") },
        el("div", { class: "k" }, "ZR"),
        el("div", { class: "v" }, String(z.zr_total)));
  const right = el("div", { class: "sh-meters" },
    el("div", { class: "sh-meter zoetic", title: zpTitle },
      el("div", { class: "k" }, "ZP"),
      el("div", { class: "v", style: z.zp_remaining < 0 ? "color:var(--bad)" : "" },
        String(zpCurrent), el("span", { class: "max" }, ` / ${z.zp}`))),
    zrMeter,
    el("div", { class: "sh-meter zoetic", title: "Ghost Rating" },
      el("div", { class: "k" }, "Ghost"),
      el("div", { class: "v" }, z.ghost_rating || "2d6")),
    el("div", { class: "sh-meter cash", role: "button", tabindex: "0",
      title: `Adjust ${RULES.currencyName().toLowerCase()}`, onclick: adjustCash,
      onkeydown: e => { if (e.key === "Enter") adjustCash(); } },
      el("div", { class: "k" }, RULES.currencyName()),
      el("div", { class: "v" }, fmt(play.cash), el("span", { class: "plus" }, " +"))));

  // Freeform character description, sitting between identity and the meters.
  // Editing it in play writes to play, not to the chargen record — a character
  // changing how they look at the table shouldn't rewrite how they were built.
  // Falls back to the chargen text until play has its own.
  const descField = el("div", { class: "sh-desc" },
    el("textarea", { class: "sh-desc-input", placeholder: "Character description…",
      spellcheck: "true",
      oninput: e => { play.description = e.target.value; schedulePlaySave(); } },
      play.description ?? CHAR.description ?? ""));

  // Top band: identity (hamburger + name, details underneath) on the left,
  // description in the middle, meters on the right.
  const top = el("div", { class: "sh-top" }, ident, descField, right);
  // Pool band: the four pool tiles as a single 1×4 row travelling across to sit
  // under the meters. (Load/Save/New moved into the ☰ menu.)
  const poolBar = el("div", { class: "sh-poolbar" }, pools);

  head.append(top, poolBar);
  return head;
}

/* Sticky bar under the header: the tab strip (always visible) plus a compact
 * summary strip (name, pool pills, ZP, cash) that appears only once the full
 * header has scrolled out of view — so play-mode essentials stay reachable
 * without the header permanently eating half a tablet screen. */
function sheetStickyBar() {
  const nav = el("nav", { class: "sh-tabs" });
  for (const [id, label] of sheetTabList()) {
    nav.append(el("button", {
      class: id === sheetTab ? "active" : "",
      onclick: () => {
        sheetTab = id;
        sheetStickyScrolled = false;   // tab switch scrolls back to the top
        renderSheet();
        window.scrollTo(0, 0);
      },
    }, label));
  }
  const zp = zpMeterValues();
  // Clicking any non-interactive part of the compact strip jumps back to the top
  // (its +/- pills and the cash meter are <button>/[role=button], so they're
  // excluded and keep working).
  const compact = el("div", { class: "sh-compact", title: "Back to top",
    onclick: e => { if (!e.target.closest("button, [role=button]")) scrollSheetToTop(); } },
    el("span", { class: "sh-compact-name" }, CHAR.name || "Unnamed"),
    ...POOL_ORDER.map(compactPoolPill),
    compactKismetPill(),
    el("span", { class: "sh-cmeter zoetic", title: "Effective / maximum Zoetic Potential" },
      `ZP ${zp.current}/${zp.max}`),
    el("span", { class: "sh-cmeter cash", role: "button", tabindex: "0",
      title: `Adjust ${RULES.currencyName().toLowerCase()}`, onclick: adjustCash,
      onkeydown: e => { if (e.key === "Enter") adjustCash(); } },
      fmt(CHAR.play.cash)));
  return el("div", { class: "sh-stickybar" + (sheetStickyScrolled ? " scrolled" : "") },
    compact, nav);
}

/* One pool as a slim pill for the compact strip — same play-state math and
 * mutation path as headerPoolTile(), minus temp boosts and notes. */
function compactPoolPill(pool) {
  const s = poolState(pool);
  const btn = (label, fn, title) => el("button", { class: "mini-btn", title,
    onclick: e => { e.stopPropagation(); fn(); } }, label);
  return el("span", { class: `sh-cpool ${pool.toLowerCase()}`,
    title: `${pool}: ${s.remaining} of ${s.max} dice left` },
    el("span", { class: "k" }, pool.slice(0, 3)),
    el("b", {}, `${s.remaining}/${s.max}`),
    btn("−", () => s.setUsed(s.used + 1), `Spend a ${pool} die`),
    btn("+", () => s.setUsed(s.used - 1), `Return a spent ${pool} die`));
}

function compactKismetPill() {
  const s = kismetPoolState();
  const btn = (label, fn, title) => el("button", { class: "mini-btn", title,
    onclick: e => { e.stopPropagation(); fn(); } }, label);
  return el("span", { class: "sh-cpool kismet",
    title: `Kismet dice: ${s.remaining} of ${s.max} left` },
    el("span", { class: "k" }, "Kis"),
    el("b", {}, `${s.remaining}/${s.max}`),
    btn("−", () => s.setUsed(s.used + 1), "Spend a Kismet die"),
    btn("+", () => s.setUsed(s.used - 1), "Return a spent Kismet die"));
}

/* One pool tile in the header: shows dice remaining / max, lets the player
 * mark dice as spent (−), return one (+), or reset to full (↺), and lists
 * any bonus-dice notes (soak dice, Specialization, Adrenal Pump, …) from
 * CALC.pool_notes. Clicking the tile itself shows the pool's skills on the
 * Overview tab. */
/* Shared pool math for the header tiles and the compact sticky-bar pills:
 * max includes temporary boost dice, used is clamped into [0, max], and
 * setUsed persists + re-renders via playChanged(). */
function poolState(pool) {
  const play = CHAR.play;
  play.pool_boost = play.pool_boost || {};
  play.pool_kismet = play.pool_kismet || {};
  const kismetDice = Math.max(0, play.pool_kismet[pool] || 0);   // permanent, never removed
  const base = CALC.pools[pool];   // already includes permanent Kismet dice
  const boost = play.pool_boost[pool] || 0;   // temporary bonus/penalty dice (may be negative)
  const max = Math.max(0, base + boost);      // effective pool never drops below 0
  const used = Math.max(0, Math.min(play.pool_used[pool] || 0, max));
  return {
    kismetDice, boost, max, used, remaining: max - used,
    setUsed: v => { play.pool_used[pool] = Math.max(0, Math.min(max, v)); playChanged(); },
    setBoost: v => { play.pool_boost[pool] = v; playChanged(); },   // negatives allowed (penalties)
  };
}

function kismetPoolState() {
  const play = CHAR.play;
  play.pool_used = play.pool_used || {};
  const max = 1 + Math.floor((play.kismet_earned || 0) / 10);
  const used = Math.max(0, Math.min(play.pool_used.Kismet || 0, max));
  return {
    max, used, remaining: max - used,
    setUsed: v => { play.pool_used.Kismet = Math.max(0, Math.min(max, v)); playChanged(); },
  };
}

function headerPoolTile(pool) {
  const { kismetDice, boost, max, used, remaining, setUsed, setBoost } = poolState(pool);
  const btn = (label, fn, title) => el("button", { class: "mini-btn", title,
    onclick: e => { e.stopPropagation(); fn(); } }, label);
  const notes = (CALC.pool_notes || {})[pool] || [];
  return el("div", {
    class: `sh-pool ${pool.toLowerCase()}` + (expandedPool === pool ? " open" : ""),
    role: "button", tabindex: "0",
    title: `${pool}: ${remaining} of ${max} dice left — click to show ${pool} skills`,
    "aria-label": `${pool} pool ${remaining} of ${max} — show ${pool} skills`,
    onclick: () => {
      expandedPool = expandedPool === pool ? null : pool;
      if (expandedPool && sheetTab !== "overview") sheetTab = "overview";
      renderSheet();
    },
    onkeydown: e => { if (e.key === "Enter" || e.key === " ") e.currentTarget.click(); },
  },
    // permanent Kismet-die tracker, upper-right (major boon — cannot be removed)
    el("div", { class: "sh-pool-kismet",
      title: `${kismetDice} permanent Kismet die(s) in ${pool} — major boon, cannot be removed` },
      `◈ ${kismetDice}`),
    el("div", { class: "k" }, pool),
    el("div", { class: "v" }, String(remaining),
      el("span", { class: "max" }, ` / ${max}`)),
    el("div", { class: "sh-pool-btns" },
      btn("−", () => setUsed(used + 1), "Spend a die from this pool"),
      btn("+", () => setUsed(used - 1), "Return a spent die"),
      btn("↺", () => setUsed(0), "Reset pool to full")),
    el("div", { class: "sh-pool-boost", onclick: e => e.stopPropagation() },
      el("span", { class: "sub" }, "temp"),
      btn("−", () => setBoost(boost - 1), "Reduce temporary dice (can go negative)"),
      el("b", { title: "Temporary bonus/penalty dice",
        style: boost > 0 ? "color:var(--ok)" : boost < 0 ? "color:var(--bad)" : "" },
        boost > 0 ? `+${boost}` : boost < 0 ? `−${Math.abs(boost)}` : "+0"),
      btn("+", () => setBoost(boost + 1), "Add temporary dice"),
      boost ? btn("↺", () => setBoost(0), "Reset temporary dice to 0") : null),
    ...notes.map(n => el("div", { class: "sh-pool-note" }, n)));
}

/* Kismet die pool — 1 die to start, +1 per 10 Kismet earned during play
 * (lifetime, from play.kismet_earned; never shrinks). Tracked as its own
 * used-dice counter, same pattern as the four attribute pools above. */
function kismetPoolTile() {
  const { max, used, remaining, setUsed } = kismetPoolState();
  const btn = (label, fn, title) => el("button", { class: "mini-btn", title,
    onclick: e => { e.stopPropagation(); fn(); } }, label);
  return el("div", {
    class: "sh-pool kismet",
    title: `Kismet dice: ${remaining} of ${max} left — 1 to start, +1 per 10 Kismet earned`,
    "aria-label": `Kismet dice ${remaining} of ${max}`,
  },
    el("div", { class: "k" }, "Kismet"),
    el("div", { class: "v" }, String(remaining),
      el("span", { class: "max" }, ` / ${max}`)),
    el("div", { class: "sh-pool-btns" },
      btn("−", () => setUsed(used + 1), "Spend a Kismet die"),
      btn("+", () => setUsed(used - 1), "Return a spent Kismet die"),
      btn("↺", () => setUsed(0), "Reset Kismet dice to full")));
}

function adjustCash() {
  const raw = prompt(`Adjust ${RULES.currencyName().toLowerCase()} by (negative to spend):`, "0");
  if (raw == null) return;
  const delta = parseInt(raw, 10);
  if (!Number.isFinite(delta) || !delta) return;
  const label = (prompt("Reason (optional):", "") || "Manual adjustment").trim() || "Manual adjustment";
  logCash(label, delta);
  playChanged();
}

/* Collapsible hamburger menu (upper-left of the sheet header) holding the
 * less-frequent whole-character actions: leaving/reverting chargen state,
 * Homebrew, and import/export. `act()` closes the menu and re-renders once
 * the action settles, unless the action already navigated away from #sheet
 * (backToChargen, enterHomebrew) in which case that view's own render wins. */
function sheetMenu() {
  const importInput = el("input", {
    type: "file", accept: ".json,application/json", hidden: "1",
    onchange: async e => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { parsed = null; }
      const shape = RULES.validateCharacterShape(parsed);
      if (!shape.ok) {
        alert("That file doesn't look like an exported Sinless character:\n\n"
          + shape.problems.map(p => "  • " + p).join("\n"));
        return;
      }
      sheetMenuOpen = false;
      const merged = RULES.mergeDefaults(parsed);
      if (merged.name) STORAGE.saveCharacter(merged);   // so it shows in the Load list
      await openCharacter(merged);                      // opens in its own tab
      if (typeof refreshLoadList === "function") refreshLoadList();
    },
  });

  // A separate input rather than widening the one above: two formats, two
  // failure messages, so "that isn't a character file" always names the right
  // format. See static/md-import.js.
  const importMdInput = el("input", {
    type: "file", accept: ".md,.markdown,.txt,text/markdown", hidden: "1",
    onchange: async e => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      sheetMenuOpen = false;
      await importMarkdownFile(file);
    },
  });

  const act = fn => async () => {
    sheetMenuOpen = false;
    await fn();
    rerenderApp();
  };

  const toggle = el("button", {
    class: "sh-menu-btn", "aria-label": "Menu", "aria-haspopup": "true",
    "aria-expanded": String(sheetMenuOpen),
    onclick: () => { sheetMenuOpen = !sheetMenuOpen; renderWorkspaceBar(); },
  }, el("span", { class: "bar" }), el("span", { class: "bar" }), el("span", { class: "bar" }));

  const wrap = el("div", { class: "sh-menu" }, toggle);
  if (sheetMenuOpen) {
    const ro = !!(activeTabObj() && activeTabObj().readonly);
    const synced = typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled();

    // Group 1 — Load / Save / New (character files). Load is the same picker as
    // the header; Save mirrors it (incl. the "Saved ✓" flash) and stays open so
    // the confirmation is visible. Save is hidden on a read-only shared view —
    // use "Save a copy" in the banner instead.
    const loadSel = el("select", { class: "btn-select sh-mi-load", onchange: async e => {
      const name = e.target.value;
      if (!name) return;
      const loaded = STORAGE.loadCharacter(name);
      if (!loaded) { e.target.value = ""; return; }
      sheetMenuOpen = false;
      await openCharacter(RULES.mergeDefaults(loaded));
      e.target.value = "";
    } }, el("option", { value: "" }, "Load…"),
      ...STORAGE.listCharacters().map(n => el("option", { value: n }, n)));
    const saveBtn = !ro ? el("button", { class: "btn sh-mi-save", onclick: () => {
      if (!CHAR.name) { alert("Give the character a street name first."); return; }
      // Same silent-overwrite path as Finalize: the save keys on the sanitised
      // name, so an unrelated character with a matching one is replaced.
      const clash = STORAGE.collidingCharacter(CHAR);
      if (clash && !confirm(`"${clash}" is already saved under this name.\n\n`
        + "Saving REPLACES that character permanently. Overwrite them?")) return;
      STORAGE.saveCharacter(CHAR);
      if (typeof refreshLoadList === "function") refreshLoadList();
      saveBtn.textContent = "Saved ✓";
      setTimeout(() => { saveBtn.textContent = "Save"; }, 1200);
    } }, "Save") : null;
    const renameBtn = !ro ? el("button", { class: "btn sh-mi-plain",
      title: "Rename this character and move its save — not a copy",
      onclick: act(renameCharacter) }, "Rename…") : null;
    const newBtn = el("button", { class: "btn sh-mi-plain", onclick: () => {
      sheetMenuOpen = false; newCharacterTab();
    } }, "New");

    // Group 2 — Import / Export.
    const importBtn = el("button", { class: "btn sh-mi-load", onclick: () => importInput.click() }, "Import JSON");
    const importMdBtn = el("button", { class: "btn sh-mi-load",
      title: "Rebuild a character from a Markdown (Scabard) export — opens in the character generator",
      onclick: () => importMdInput.click() }, "Import Markdown");
    const exportJsonBtn = el("button", { class: "btn sh-mi-save", onclick: act(() => {
      const blob = new Blob([JSON.stringify(CHAR, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob),
        download: (CHAR.name || "character") + ".json" });
      a.click();
    }) }, "Export JSON");
    // Export Markdown reads the finalized play sheet; only offer it in play mode.
    const exportMdBtn = CHAR.finalized
      ? el("button", { class: "btn sh-mi-save", onclick: act(exportMarkdown) }, "Export Markdown (Scabard)") : null;

    // Group 3 — Sharing / Shared characters / Homebrew (sharing + gallery need a backend).
    const sharingBtn = (synced && !ro && CHAR.name)
      ? el("button", { class: "btn sh-mi-plain", onclick: act(toggleSharing) },
          SYNC.isPublic(STORAGE.sanitizeName(CHAR.name))
            ? "Sharing: Public ✓ — make private"
            : "Sharing: Private — make public")
      : null;
    const sharedBtn = synced
      ? el("button", { class: "btn sh-mi-plain", onclick: act(openSharedGallery) }, "Shared characters") : null;
    const homebrewBtn = el("button", { class: "btn sh-mi-brew", onclick: act(enterHomebrew) }, "Homebrew");

    // Group 4 — Back to Chargen / Revert / Delete. Back/Revert only apply to a
    // finalized character (they toggle play state), so hide them in chargen.
    const backBtn = CHAR.finalized
      ? el("button", { class: "btn sh-mi-plain", onclick: act(backToChargen) }, "← Back to Chargen") : null;
    const resyncBtn = (CHAR.finalized && !ro && CHAR.play && CHAR.play.kit)
      ? el("button", { class: "btn sh-mi-plain",
          title: "Rebuild play's copy of the items you still own from the chargen build",
          onclick: act(resyncKitFromBuild) }, "Re-sync Build → Kit") : null;
    const revertBtn = CHAR.finalized
      ? el("button", { class: "btn warn", onclick: act(revertToChargenEnd) }, "Revert to Post-Chargen") : null;
    const deleteBtn = el("button", { class: "btn sh-mi-delete", disabled: CHAR.name ? null : "1",
      title: CHAR.name ? "Permanently delete this character's save" : "Character has no name — nothing saved to delete",
      onclick: act(() => deleteSavedCharacter(CHAR.name)) }, "Delete Character");

    // Group 5 — Admin / Sign out (danger red; only when signed in).
    const adminBtn = (synced && SYNC.isAdmin())
      ? el("button", { class: "btn sh-mi-danger", onclick: act(openAdminPanel) }, "Admin") : null;
    const signOutBtn = synced
      ? el("button", { class: "btn sh-mi-danger", onclick: act(doSignOut) }, "Sign out") : null;

    const groups = [
      [loadSel, saveBtn, renameBtn, newBtn],
      [importBtn, importMdBtn, exportJsonBtn, exportMdBtn],
      [sharingBtn, sharedBtn, homebrewBtn],
      [backBtn, resyncBtn, revertBtn, deleteBtn],
      [adminBtn, signOutBtn],
    ].map(g => g.filter(Boolean)).filter(g => g.length);

    const panel = el("div", { class: "sh-menu-panel", role: "menu" });
    groups.forEach((g, i) => {
      if (i > 0) panel.append(el("div", { class: "sh-menu-sep" }));
      g.forEach(b => panel.append(b));
    });
    panel.append(importInput, importMdInput);

    wrap.append(
      el("div", { class: "sh-menu-backdrop", onclick: () => { sheetMenuOpen = false; renderWorkspaceBar(); } }),
      panel);
  }
  return wrap;
}
/* Rename a character, moving its save rather than forking it. Typing a new name
 * into the chargen field and saving leaves the old slot behind — two characters
 * where the player meant one — so this writes the new slot, re-points sharing at
 * it, and deletes the old one. Storage keys are sanitised, so "Jimmy Chan" and
 * "Jimmy-Chan" are the same slot and renaming between them is a no-op move. */
async function renameCharacter() {
  const oldName = CHAR.name || "";
  const next = (prompt("New name for this character:", oldName) || "").trim();
  if (!next || next === oldName) return;
  const oldSlug = CHAR.saved_as || (oldName ? STORAGE.sanitizeName(oldName) : "");
  const newSlug = STORAGE.sanitizeName(next);
  // Someone else already in the destination slot: renaming would overwrite them.
  const clash = STORAGE.collidingCharacter({ name: next, saved_as: oldSlug });
  if (clash && !confirm(`"${clash}" is already saved under that name.\n\n`
    + `Renaming REPLACES that character permanently — their build, play state `
    + "and history all go.\n\nOverwrite them?")) return;
  const wasPublic = typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled()
    && oldSlug && SYNC.isPublic(oldSlug);
  CHAR.name = next;
  CHAR.saved_as = newSlug;
  if (oldSlug) STORAGE.saveCharacter(CHAR);      // unnamed drafts have nothing to move
  // Sharing is keyed by slug, so a shared character has to be re-published under
  // the new one. Links to the old slug are dead either way — the slug IS the URL.
  if (wasPublic && newSlug !== oldSlug) {
    await SYNC.setVisibility(newSlug, true);
    await SYNC.setVisibility(oldSlug, false);
  }
  if (oldSlug && newSlug !== oldSlug) STORAGE.deleteCharacter(oldSlug);
  if (typeof refreshLoadList === "function") refreshLoadList();
  await recalc();
  showActiveTab();
  renderWorkspaceBar();     // the tab carries the name too
  persistWorkspace();
}

/* "carried_qty 10 → 8" for every field a re-sync would actually change, so it
 * can be judged row by row instead of on faith.
 *
 * Only fields the BUILD carries are compared. A weapon in play also holds
 * things chargen has never heard of — chambered ammo, rounds loaded, firing
 * mode, kata — and those are play's alone: the build has no opinion on them, so
 * they are neither a difference to report nor anything a re-sync should touch.
 * Reporting them made every fired gun look out of step and offered to blank the
 * magazine. */
function entryDiff(kitEntry, buildEntry) {
  const show = v => {
    if (Array.isArray(v)) return v.length ? v.map(entryLabel).join(", ") : "none";
    if (v === "" || v == null) return "—";
    return String(v);
  };
  const out = [];
  for (const key of Object.keys(buildEntry || {})) {
    if (key === "name") continue;
    const a = (kitEntry || {})[key], b = (buildEntry || {})[key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out.push(`${key} ${show(a)} → ${show(b)}`);
  }
  return out.join(" · ");
}

/* Lay the build's version of an item over play's copy, field by field. Not a
 * wholesale replacement: play-only keys (see entryDiff) survive, so re-syncing
 * a rifle's mods doesn't unload it. */
function applyBuildEntry(into, from) {
  for (const [key, value] of Object.entries(from || {})) into[key] = deepCopyEntry(value);
  return into;
}

/* Which of the out-of-step items to rebuild from the build. Resolves to the
 * chosen subset, or null if the player backed out. Nothing is ticked to start
 * with — the safe answer is "change nothing". */
function promptKitResync(pending) {
  return new Promise(resolve => {
    const backdrop = el("div", { class: "mount-modal-backdrop" });
    const done = val => {
      document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(val);
    };
    const onKey = e => { if (e.key === "Escape") done(null); };
    const boxes = pending.map(p => el("input", { type: "checkbox" }));
    const rows = pending.map((p, i) => el("label", { class: "opt sh-resync-row" },
      boxes[i],
      el("span", {},
        el("b", {}, p.label),
        p.diff ? el("div", { class: "sub" }, p.diff) : null)));
    const setAll = on => boxes.forEach(b => { b.checked = on; });
    const modal = el("div", { class: "card mount-modal", style: "max-width:560px" },
      el("h3", {}, "Re-sync from the build"),
      el("p", { class: "hint" },
        "These items differ between the chargen build and play's copy. Ticking one "
        + "lays the build's version over play's copy — use it for edits made in "
        + "chargen that never reached the sheet. Leave the rest alone: flags you "
        + "changed at the table would be overwritten. Only items the build and play "
        + "both hold are listed; anything bought in play has no build version to "
        + "sync from, and a magazine or firing mode is play's alone either way."),
      el("div", { style: "display:flex;gap:8px;margin-bottom:6px" },
        el("button", { class: "btn small", onclick: () => setAll(true) }, "Select all"),
        el("button", { class: "btn small", onclick: () => setAll(false) }, "None")),
      el("div", { class: "sh-resync-list" }, ...rows),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
        el("button", { class: "btn-add",
          onclick: () => done(pending.filter((p, i) => boxes[i].checked)) }, "Re-sync ticked"),
        el("button", { class: "btn ghost", onclick: () => done(null) }, "Cancel")));
    backdrop.append(modal);
    backdrop.addEventListener("click", e => { if (e.target === backdrop) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
  });
}

/* Repair hatch: rebuild play's copy of the items the character still owns from
 * the chargen build.
 *
 * Needed because reconcileKit used to match by NAME only. A weapon you already
 * owned, re-modded in chargen, changed no names — so nothing was carried across,
 * while kit_baseline still advanced to the edited build. That leaves a character
 * permanently out of step: chargen says Blinged with three mods, the sheet shows
 * the bike as it was, and no future re-finalize can tell the difference, because
 * as far as the baseline is concerned nothing changed.
 *
 * Membership is left alone — this only rewrites the CONFIGURATION of items
 * present on both sides. Anything bought in play lives in play.purchases and is
 * never touched; anything sold in play stays sold. */
async function resyncKitFromBuild() {
  const play = CHAR.play;
  if (!play || !play.kit) { alert("Nothing to re-sync — this character has no play kit yet."); return; }
  // Work out every replacement first, so the confirm can list them and a "no"
  // leaves the character exactly as it was.
  const pending = [];
  for (const category of RULES.KIT_CATEGORIES) {
    const now = CHAR[category] || [];
    const kit = play.kit[category] = play.kit[category] || [];
    for (const name of new Set(now.map(entryLabel))) {
      const nowOnes = now.filter(e => entryLabel(e) === name);
      const kitOnes = kit.filter(e => entryLabel(e) === name);
      for (let k = 0; k < Math.min(nowOnes.length, kitOnes.length); k++) {
        // An empty diff means the build and play agree on everything the build
        // has a say in — a fired gun differs only in its magazine, and that is
        // not something to offer to "repair".
        const diff = entryDiff(kitOnes[k], nowOnes[k]);
        if (!diff) continue;
        pending.push({ category, kit, at: kit.indexOf(kitOnes[k]), entry: nowOnes[k],
          label: `${category}: ${name}`, diff });
      }
    }
  }
  if (!pending.length) { alert("Already in step — play's copy matches the build."); return; }
  // Item by item, not all or nothing: most of what differs here is the table
  // doing its job — ammo spent, grenades thrown — and only the player knows
  // which rows are the build edits that never came across.
  const picked = await promptKitResync(pending);
  if (!picked || !picked.length) return;
  picked.forEach(p => { applyBuildEntry(p.kit[p.at], p.entry); });
  // The baseline only moves for what was actually re-synced; anything left
  // deliberately out of step stays a pending chargen edit for the next
  // re-finalize to carry across.
  const base = play.kit_baseline || (play.kit_baseline = {});
  picked.forEach(p => {
    const list = base[p.category] = base[p.category] || [];
    const at = list.findIndex(e => entryLabel(e) === entryLabel(p.entry));
    if (at >= 0) list[at] = deepCopyEntry(p.entry); else list.push(deepCopyEntry(p.entry));
  });
  const changed = picked.map(p => p.label);
  logCash(`Re-synced from the build: ${changed.slice(0, 6).join(", ")}`
    + (changed.length > 6 ? ` +${changed.length - 6} more` : ""), 0);
  STORAGE.saveCharacter(CHAR);
  await recalc();
  showActiveTab();
}

/* Knowledge skills are the one kit category the play sheet ADDS to directly:
 * every other category has a play.purchases list, but a knowledge costs no cash
 * and is budgeted off Intelligence in both modes, so the sheet writes it
 * straight into the kit. That left one added in play invisible on the chargen
 * tab, so players re-added it there — and re-finalize, seeing a genuinely new
 * chargen entry, pushed a second copy into the kit (issue #35).
 *
 * Going back to chargen therefore folds them into the build: the same points
 * against the same Intelligence budget, just now visible where they're edited.
 * The baseline moves with it so the next re-finalize sees nothing new to add.
 * This is a deliberate, narrow exception to "play never writes to the build" —
 * it is safe precisely because knowledge spends no creation cash. */
function syncKnowledgeToBuild() {
  const play = CHAR.play;
  if (!play || !play.kit) return 0;
  const build = CHAR.knowledge_skills = CHAR.knowledge_skills || [];
  const key = k => String((k || {}).name || "").trim().toLowerCase();
  let moved = 0;
  for (const k of play.kit.knowledge_skills || []) {
    if (!key(k)) continue;                       // an unnamed row is a half-typed one
    const found = build.find(b => key(b) === key(k));
    if (!found) { build.push({ name: k.name, points: k.points }); moved++; }
    else if (found.points !== k.points) { found.points = k.points; moved++; }
  }
  if (moved) {
    play.kit_baseline = play.kit_baseline || {};
    play.kit_baseline.knowledge_skills = JSON.parse(JSON.stringify(build));
  }
  return moved;
}

async function backToChargen() {
  if (!confirm("Return to character generation?\n\nChargen budgets become editable again. "
    + "Play state (damage, Kismet, notes, advances, purchases) is kept and returns when you re-finalize."))
    return;
  CHAR.finalized = false;
  syncKnowledgeToBuild();      // so knowledges added in play are visible where they're edited
  schedulePlaySave();
  await recalc();
  exitSheet();
  renderTabs();
  renderPanel();
  renderWorkspaceBar();   // state dot flips play -> chargen
  persistWorkspace();
}

/* ------------------------------------------------ overview */
// Drag-to-reorder a table row backed by `arr` (the row represents `item`, an
// element of arr). Dropping onto another reorderable row of the same array moves
// item there, persists, and re-renders. Non-reorderable rows (cyberguns, granted
// armor) simply don't call this, so they stay put.
// Row reordering via ▲/▼ buttons. Native <tr> drag-and-drop is unreliable in
// tables (drag-image / drop hit-testing quirks) and dead on touch, so loadout
// rows reorder with explicit buttons instead. reorderHandle renders the control.
function reorderHandle(up, down, canUp, canDown) {
  const mk = (label, fn, ok, title) => el("button", {
    class: "sh-reorder-btn", title, ...(ok ? {} : { disabled: "1" }),
    onclick: e => { e.stopPropagation(); if (ok) fn(); } }, label);
  return el("span", { class: "sh-reorder" },
    mk("▲", up, canUp, "Move up"),
    mk("▼", down, canDown, "Move down"));
}
// A unified loadout list can span different backing stores (equipped weapons,
// cybergun augments, worn armor, derived granted-armor rows). Each item exposes
// getOrder()/setOrder(v) onto its own store and an `ins` insertion index used as
// the tiebreak before any custom order exists. loadoutSort orders the list;
// loadoutMove swaps two neighbours and renumbers every item's stored order.
function loadoutSort(items) {
  return items.sort((a, b) => {
    const ao = Number.isFinite(a.getOrder()) ? a.getOrder() : 1e6 + a.ins;
    const bo = Number.isFinite(b.getOrder()) ? b.getOrder() : 1e6 + b.ins;
    return ao - bo;
  });
}
function loadoutMove(items, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  items.forEach((it, k) => it.setOrder(k));
  playChanged();
}
// The Gear tab lists ARE their backing array in order, so reordering there moves
// the element itself rather than layering a stored order over several stores.
// `after` re-renders: playChanged for name-keyed lists, playChangedRecalc where
// a CALC array is index-aligned to the one being moved (armor).
/* Reordering swaps two entries in place. Every list the play sheet can reorder
 * is play's own — the kit or a purchases array — so this is just a swap. */
function arrayMove(arr, i, dir, after = playChanged) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  after();
}
/* Same swap, but between two arbitrary slots. A grouped list (the Gear tab's
 * gear table, split into Class headings) shows a category's rows as a subset of
 * its backing array, so "move up" means swapping with the previous row of the
 * SAME category — not the previous array slot, which may belong to another
 * heading. Only the two entries move; every other item keeps its index. */
function arraySwap(arr, i, j, after = playChanged) {
  if (i === j || i < 0 || j < 0 || i >= arr.length || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  after();
}

// Cyberguns are augments with a chosen gun; surface them as read-only weapons
// on the Overview loadout and the Gear weapons list.
function equippedCyberguns() {
  // Keep the source augment entry + its array so the Overview can drag-reorder
  // cyberguns (they're derived, so reordering acts on the underlying augments).
  const sources = [
    kitOf("augments"),
    (CHAR.play && CHAR.play.purchases && CHAR.play.purchases.augments) || [],
  ];
  const out = [];
  let ins = 0;
  for (const arr of sources) {
    for (const a of arr) {
      if (a.name !== "Cybergun Installation" || !a.gunType) continue;
      const g = (DATA.tables.cyberguns || []).find(x => x.Type === a.gunType);
      if (g) out.push({ name: `Cybergun — ${g.Type}`, gun: g, src: a, _ins: ins++ });
    }
  }
  // A custom drag order is stored on each source augment as cgOrder, unifying the
  // order across both arrays; entries without it keep insertion order, last.
  return out.sort((a, b) =>
    (typeof a.src.cgOrder === "number" ? a.src.cgOrder : 1e6 + a._ins)
    - (typeof b.src.cgOrder === "number" ? b.src.cgOrder : 1e6 + b._ins));
}

/* Ammo the character actually owns, by name -- chargen kit plus anything bought
   in play, merged, since you load from one stock. */
function ownedAmmoRows() {
  const seen = new Map();
  for (const g of allGear()) {
    const row = DATA.tables.misc_gear.find(x => x.Item === g.name);
    if (row && (row.Class || "").startsWith("Ammo") && !seen.has(row.Item)) seen.set(row.Item, row);
  }
  return [...seen.values()];
}

/* Ammo the character owns that this particular weapon will actually chamber. */
function ammoOptionsFor(weaponRow) {
  return ownedAmmoRows().filter(r => RULES.ammoFitsWeapon(r, weaponRow));
}

/* Which ammo an entry is loaded with. An unset choice falls back to Standard --
   the plain rounds a gun is assumed to carry, and they have no effect, so the
   default changes no numbers. Falls through to nothing when the character owns
   no Standard, when a previously chosen type has since been sold off, and when
   a choice made before the compatibility rules no longer fits this weapon. */
function ammoNameFor(entry, weaponRow) {
  const fits = ammoOptionsFor(weaponRow);
  if (fits.some(x => x.Item === entry.ammo)) return entry.ammo;
  if (entry.ammo === "") return "";                       // explicitly unloaded
  return fits.some(x => x.Item === "Standard") ? "Standard" : "";
}

/* The ammo an entry is loaded with, plus its parsed stat mods. */
function loadedAmmoFor(entry, weaponRow) {
  const none = { row: null, name: "", mods: RULES.ammoStatMods(""), notes: [] };
  const name = ammoNameFor(entry, weaponRow);
  if (!name) return none;
  const row = ownedAmmoRows().find(x => x.Item === name);
  if (!row) return none;
  const mods = RULES.ammoStatMods(row.Effect);
  const notes = [...mods.notes, row.Notes || ""].filter(Boolean);
  return { row, name: row.Item, mods, notes };
}

/* Grenades the character owns. A launcher is loaded with these rather than with
   ammunition -- its own Damage reads "By Grenade" -- and they're weapons in the
   data, so they come from CHAR.weapons. Thrown weapons that aren't grenades
   (Knife, Shuriken, Molotov) are not launchable. */
function ownedGrenadeRows() {
  const seen = new Map();
  for (const w of allWeapons()) {
    const row = DATA.tables.weapons.find(x => x.Weapon === w.name);
    if (row && row.Type === "Thrown" && /grenade/i.test(row.Weapon) && !seen.has(row.Weapon))
      seen.set(row.Weapon, row);
  }
  return [...seen.values()];
}

/* What a launcher currently has chambered, and the stats it lends. Unlike ammo
   there's no sensible default -- an empty launcher deals "By Grenade". */
function loadedGrenadeFor(entry) {
  const row = ownedGrenadeRows().find(x => x.Weapon === entry.ammo);
  if (!row) return { row: null, name: "", notes: [] };
  return { row, name: row.Weapon, notes: [row.Notes || ""].filter(Boolean) };
}

/* Munition selector. Melee and thrown weapons load nothing, and neither do
   Energy weapons -- they run on Heat. Grenade launchers pick a grenade;
   everything else that fires, cyberguns included, picks ammunition. */
function munitionPicker(entry, weaponRow) {
  const type = (weaponRow || {}).Type;
  if (["Melee", "Thrown", "Energy"].includes(type)) return "—";
  const launcher = type === "GrenadeLauncher";
  const owned = launcher ? ownedGrenadeRows() : ammoOptionsFor(weaponRow);
  const key = r => (launcher ? r.Weapon : r.Item);
  if (!owned.length)
    return el("span", { class: "sub" },
      launcher ? "no grenades owned"
        : (ownedAmmoRows().length ? "none this weapon takes" : "none owned"));
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const cur = launcher ? loadedGrenadeFor(entry).name : ammoNameFor(entry, weaponRow);
  if (ro) return el("span", { class: "sub" }, cur || "—");
  // Names only. What each round DOES is already spelled out in the Ammo table
  // under this one, and repeating it inside every option made the dropdown —
  // and with it the whole Ammo column — as wide as the weapon names. The detail
  // rides along as each option's tooltip.
  const label = r => launcher ? r.Weapon.replace(/\s*Grenade$/i, "") : r.Item;
  const detail = r => launcher
    ? `DMG ${r.Damage || "—"}`
    : (r.Effect || "no special effect");
  return el("select", { class: "sh-fire-sel sh-ammo-sel",
    title: launcher ? "Chambered grenade" : "Loaded ammunition",
    onchange: e => { entry.ammo = e.target.value; playChanged(); } },
    el("option", { value: "" }, launcher ? "— empty —" : "— none —"),
    ...owned.map(r => el("option", { value: key(r), title: detail(r),
      ...(key(r) === cur ? { selected: 1 } : {}) }, label(r))));
}

/* What a mount is loaded with, and the stat mods it lends. Same parsing as
   personal ammo -- the exotic rounds state their effect the same way. */
function unitLoadedAmmo(table, unit, wi, wn) {
  const st = unitGunState(table, unit, wi);
  const fits = ownedAmmoRows().filter(a => RULES.ammoFitsUnitWeapon(a, wn));
  const row = fits.find(a => a.Item === st.ammo);
  if (!row) return { row: null, name: "", mods: RULES.ammoStatMods(""), notes: [] };
  const mods = RULES.ammoStatMods(row.Effect);
  return { row, name: row.Item, mods, notes: mods.notes };
}

/* Firing state for a mount, kept in play state because a unit's weapons are
   stored as bare names with nothing to hang it on. Keyed by the unit's slot and
   the weapon's index within it, alongside the condition tracks. */
function unitGunState(table, unit, wi) {
  const rg = CHAR.play.rigging;
  const slot = (rg.units[unitStateKey(table, unit)] ??= {});
  const guns = (slot.guns ??= {});
  return (guns[wi] ??= {});
}

/* Firing controls for a mounted weapon: mode + magazine for a ballistic mount,
   a heat tracker for an energy one. Energy mounts state Heat and Heat Limit in
   their own columns, so unlike personal energy weapons nothing has to be parsed
   out of prose. */
function unitGunControls(table, unit, wi, wn, wr, isEnergy) {
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const st = unitGunState(table, unit, wi);
  const wrap = el("div", { class: "sh-fire" });

  if (isEnergy) {
    const per = parseInt(wr.Heat, 10) || 0;
    const max = parseInt(wr["Heat Limit"], 10) || 0;
    if (!per && !max) return null;                 // no heat rating on this mount
    const cur = () => (st.heat == null ? 1 : Math.max(0, Math.floor(+st.heat) || 0));
    if (ro) wrap.append(el("span", { class: "sub" }, `Heat ${cur()}`));
    else wrap.append(miniCounter("Heat", cur, v => { st.heat = v; }, 0, max || 99));
    wrap.append(el("span", { class: "sub" },
      ` ${per} per shot · max ${max}${max && cur() >= max ? " — overheated" : ""}`));
    return wrap;
  }

  const modes = RULES.weaponFiringModes(wr);
  if (!modes.length) return null;                  // Oil Slick / Smokescreen
  const mode = modes.includes(st.mode) ? st.mode : modes[0];
  const md = RULES.firingMode(mode);
  wrap.append(modes.length > 1 && !ro
    ? el("select", { class: "sh-fire-sel", title: "Firing mode",
        onchange: e => { st.mode = e.target.value; playChanged(); } },
        ...modes.map(m => {
          const d = RULES.firingMode(m);
          return el("option", { value: m, ...(m === mode ? { selected: 1 } : {}) },
            `${m} — ${d.name} (${d.dice ? `+${d.dice}b, ` : ""}${d.ammo} rd${d.ammo === 1 ? "" : "s"})`);
        }))
    : el("span", { class: "sh-fire-mode", title: md.name }, mode));

  // "1 missile" and the like aren't counts, so those mounts get no magazine.
  const maxAmmo = /^\s*\d+\s*$/.test(String(wr.Ammo || "")) ? parseInt(wr.Ammo, 10) : 0;
  if (maxAmmo) {
    const loaded = st.loaded == null ? maxAmmo
      : Math.max(0, Math.min(Math.floor(+st.loaded) || 0, maxAmmo));
    const dry = loaded < md.ammo;
    wrap.append(el("span", { class: "sh-fire-mag" + (dry ? " dry" : "") },
      `${loaded}/${maxAmmo} rds`));
    if (!ro) wrap.append(
      el("button", { class: "btn small", disabled: dry ? "1" : null,
        title: dry ? `Not enough rounds for ${mode} (needs ${md.ammo})`
                   : `Fire ${mode} — spends ${md.ammo} round${md.ammo === 1 ? "" : "s"}`,
        onclick: () => { st.loaded = Math.max(0, loaded - md.ammo); playChanged(); } }, "Fire"),
      el("button", { class: "btn small", disabled: loaded >= maxAmmo ? "1" : null,
        title: "Reload to a full magazine",
        onclick: () => { st.loaded = maxAmmo; playChanged(); } }, "Reload"));
  }

  // Exotic rounds are mount-specific; ordinary personal ammo never fits one.
  const fits = ownedAmmoRows().filter(a => RULES.ammoFitsUnitWeapon(a, wn));
  if (fits.length && !ro) {
    const cur = fits.some(a => a.Item === st.ammo) ? st.ammo : "";
    wrap.append(el("select", { class: "sh-fire-sel", title: "Loaded ammunition",
      onchange: e => { st.ammo = e.target.value; playChanged(); } },
      el("option", { value: "" }, "— none —"),
      ...fits.map(a => el("option", { value: a.Item, ...(a.Item === cur ? { selected: 1 } : {}) },
        a.Effect ? `${a.Item} — ${a.Effect}` : a.Item))));
  }
  return wrap;
}

/* Firing state for a trait-mounted weapon (a Heavy Torso / No Head free mount).
 * Those aren't owned entries — they're derived from the heritage picks on every
 * recalc — so the magazine, mode and Gun-Kata flag live in play state, keyed by
 * the mount's label. Same shape firingModeControls expects of a weapon entry. */
function traitMountState(label) {
  const play = CHAR.play;
  const mounts = (play.trait_mounts = play.trait_mounts || {});
  return (mounts[label] = mounts[label] || {});
}

/* Gun-Kata rank, or 0. Level 2 is the one that matters here: "Can fire +1
   bullet (+1d for 1 ammo)". */
function gunKataRank() {
  const ma = (CALC.martial_arts || []).find(m => /^gun.?kata$/i.test(m.style || ""));
  return ma ? (+ma.rank || 0) : 0;
}

/* Per-shot heat and its cap, read out of an Energy weapon's Notes
   ("Heat 3 / max 15"). Null when the row doesn't state it. */
function heatSpec(row) {
  const m = /heat\s*(\d+)\s*\/\s*max\s*(\d+)/i.exec((row && row.Notes) || "");
  return m ? { per: +m[1], max: +m[2] } : null;
}

/* A weapon with no firing mode still makes an attack test — a blade, a fist, a
 * thrown grenade — so it gets the same one-press roll the guns' Fire button
 * gives, minus the ammo. Returns "—" when there's nothing to roll (an untrained
 * trained-only skill), which is what the cell used to show for all of them. */
function attackButton(label, rs, opts = {}) {
  if (!rs || rs.locked || (rs.limitDice + rs.bonus) <= 0) return "—";
  const total = rs.limitDice + rs.bonus;
  return el("div", { class: "sh-fire-btns" },
    el("button", { class: "btn small",
      title: opts.title || (`Roll ${total}d6 — ${rs.why.join(" ")}`
        + (rs.bwhy.length ? `, bonus ${rs.bwhy.join(" + ")}` : "")),
      onclick: () => openPoolRoller({ dice: rs.limitDice, bonus: rs.bonus,
        pool: rs.pool, label,
        note: opts.note
          || `${rs.skill}: ${rs.skillDice} skill`
             + (rs.acc ? ` + ${rs.acc} Accuracy` : "")
             + (rs.bonus ? ` + ${rs.bonus} bonus` : "") }),
    }, "Attack"));
}

/* Firing controls on each Overview weapon row.
 *
 * Ballistic weapons pick a firing mode -- its bonus dice are folded into the
 * dice chip beside it -- and track a magazine: Fire spends that mode's rounds,
 * Reload fills it. Rounds live on the weapon entry (like `mods` and `lo`) so
 * they survive a reload; absent means a full magazine.
 *
 * Energy weapons have no magazine. They're single-shot and run on Heat, stated
 * per shot and capped in their Notes, so they get a heat tracker instead of a
 * round count. Heat starts at 1. */
/* `label` names the thing being fired in the roller. It defaults to the entry's
 * own name, which is right for an owned weapon — but a cybergun's entry is the
 * augment that installed it ("Cybergun Installation") and a trait mount's is a
 * bare play-state record with no name at all, so both pass their own. */
function firingModeControls(w, r, calcRow, modes, mode, kataOffered = false, rollSpec = null,
                            label = null) {
  const fireLabel = label || w.name || "Attack";
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const wrap = el("div", { class: "sh-fire" });

  const optLabelFor = m => {
    const d = RULES.FIRING_MODES[m];
    return `${m} — ${d.name}${d.dice ? ` (+${d.dice}b)` : ""}`;
  };
  const modeSelect = (labelWithAmmo) => modes.length > 1 && !ro
    ? el("select", { class: "sh-fire-sel", title: "Firing mode",
        onchange: e => { w.mode = e.target.value; playChanged(); } },
        ...modes.map(m => el("option", { value: m, ...(m === mode ? { selected: 1 } : {}) },
          labelWithAmmo(m))))
    : el("span", { class: "sh-fire-mode", title: RULES.firingMode(mode).name }, mode);

  // Energy weapons carry no magazine -- Heat is the resource they spend -- so
  // they get a heat tracker rather than a round count. Most are single-shot,
  // but one that names real modes (the X-3 spins up to full auto) still picks
  // between them for the bonus dice.
  if (r.Type === "Energy") {
    const hs = heatSpec(r);
    const cur = () => (w.heat == null ? 1 : Math.max(0, Math.floor(+w.heat) || 0));
    wrap.append(modeSelect(optLabelFor));
    if (ro) wrap.append(el("span", { class: "sub" }, `Heat ${cur()}`));
    else wrap.append(miniCounter("Heat", cur, v => { w.heat = v; }, 0, hs ? hs.max : 99));
    wrap.append(el("span", { class: "sub" }, hs
      ? ` ${hs.per} per shot · max ${hs.max}${cur() >= hs.max ? " — overheated" : ""}`
      : " no heat rating listed"));
    return wrap;
  }

  const maxAmmo = Math.max(0, parseInt(calcRow.Ammo ?? r.Ammo, 10) || 0);
  const loaded = w.loaded == null ? maxAmmo
    : Math.max(0, Math.min(Math.floor(+w.loaded) || 0, maxAmmo));
  const md = RULES.firingMode(mode);
  wrap.append(modeSelect(m => {
    const d = RULES.FIRING_MODES[m];
    return `${m} — ${d.name} (${d.dice ? `+${d.dice}b, ` : ""}${d.ammo} rd${d.ammo === 1 ? "" : "s"})`;
  }));

  if (!maxAmmo) return wrap;
  // Gun-Kata 2 rides on whichever mode is selected: one more bullet, one more
  // die. Offered per weapon so it can be left off when you don't want the cost.
  const kataOn = kataOffered && !!w.kata;
  const cost = md.ammo + (kataOn ? 1 : 0);
  const dry = loaded < cost;
  wrap.append(el("span", { class: "sh-fire-mag" + (dry ? " dry" : "") },
    `${loaded}/${maxAmmo} rds`));
  if (kataOffered) {
    wrap.append(el("label", { class: "sh-fire-kata",
      title: "Gun-Kata 2: fire +1 bullet for +1 die" },
      el("input", { type: "checkbox", ...(kataOn ? { checked: 1 } : {}), ...(ro ? { disabled: "1" } : {}),
        onchange: e => { w.kata = e.target.checked; playChanged(); } }),
      el("span", {}, "Gun-Kata")));
  }
  if (ro) return wrap;
  // Fire and Reload sit together on their own line — they're the pair you reach
  // between, and the mode select and round count above are what you set once.
  const rollable = rollSpec && !rollSpec.locked
    && (rollSpec.limitDice + rollSpec.bonus) > 0;
  wrap.append(el("div", { class: "sh-fire-btns" },
    el("button", { class: "btn small", disabled: dry ? "1" : null,
      title: dry ? `Not enough rounds loaded for ${mode} (needs ${cost})`
                 : `Fire ${mode} — spends ${cost} round${cost === 1 ? "" : "s"}`
                   + (kataOn ? " (includes the Gun-Kata bullet)" : "")
                   + (rollable
                       ? ` and loads ${rollSpec.limitDice + rollSpec.bonus}d6 in the roller`
                       : ""),
      onclick: () => {
        // Same dice the chip beside it would load — firing IS the attack test,
        // so it spends the rounds and opens the roll in one press.
        if (rollable)
          openPoolRoller({ dice: rollSpec.limitDice, bonus: rollSpec.bonus,
            pool: rollSpec.pool, label: fireLabel,
            note: `${rollSpec.skill}: ${rollSpec.skillDice} skill`
              + (rollSpec.acc ? ` + ${rollSpec.acc} Accuracy` : "")
              + (rollSpec.bonus ? ` + ${rollSpec.bonus} bonus (${mode})` : "") });
        w.loaded = Math.max(0, loaded - cost);
        playChanged();
      } }, "Fire"),
    el("button", { class: "btn small", disabled: loaded >= maxAmmo ? "1" : null,
      title: "Reload to a full magazine",
      onclick: () => { w.loaded = maxAmmo; playChanged(); } }, "Reload")));
  return wrap;
}

function shOverview(body) {
  const play = CHAR.play;
  const econ = kismetEcon();
  // A shared view reads the same Overview but edits nothing on it.
  const ro = !!(activeTabObj() && activeTabObj().readonly);

  // Rules problems that survive Finalize. Creation budgets stop applying, but
  // an illegal body or an empty wallet doesn't stop being illegal — the engine
  // reports the reduced set once `finalized` is true, and this is where it
  // lands. Silent for a clean character, which is the usual case.
  if (CALC.errors.length || CALC.warnings.length) {
    const list = el("div", { class: "card sh-card sh-validity" },
      el("h3", {}, "Needs attention"),
      ...CALC.errors.map(e => el("div", { class: "sh-advrow", style: "color:var(--bad)" }, "✕ " + e)),
      ...CALC.warnings.map(w => el("div", { class: "sh-advrow", style: "color:var(--manon)" }, "⚠ " + w)));
    body.append(list);
  }

  // dossier warnings (Replicant illegality, Amp powers offline, …)
  for (const note of dossierNotes().slice(0, 2))
    body.append(el("div", { class: "sh-callout" }, "⚠ ", note));
  // Replicants have a fixed remaining lifespan, rolled once and ticked down.
  const lifespan = replicantLifespanTracker();
  if (lifespan) body.append(lifespan);

  // --- kismet + pools
  const kismetRow = el("div", { class: "sh-kismet" },
    el("span", { class: "chip magic" }, `Kismet ${play.kismet}`),
    el("span", { class: "chip" }, `Earned ${play.kismet_earned}`),
    el("span", { class: "chip" }, `Boons ${econ.regularsAvail}`),
    el("span", { class: "chip" }, `Major ${econ.majorsAvail}`),
    el("span", { class: "sh-kismet-btns" },
      counterBtn("+ Award", () => {
        const n = parseInt(prompt("Award how much Kismet?", "1") ?? "", 10);
        if (n > 0) { awardKismet("Quick award", n); playChanged(); }
      }, "good"),
      counterBtn("Kismet tab →", () => { sheetTab = "kismet"; renderSheet(); window.scrollTo(0, 0); })));

  // attributes moved down here — the header now belongs to the pool tiles
  const attrsRow = el("div", { class: "sh-attrs" });
  for (const [full, abbr] of ATTR_ABBR) {
    const a = CALC.attributes[full];
    attrsRow.append(el("div", { class: "sh-attr", title: full },
      el("div", { class: "k" }, abbr),
      el("div", { class: "v" }, String(a.final)),
      a.adjust ? el("div", { class: "adj" }, (a.adjust > 0 ? "+" : "") + a.adjust) : null));
  }
  const poolCard = el("div", { class: "card sh-card" }, kismetRow,
    el("h4", { class: "sh-h4" }, "Attributes"), attrsRow);
  if (expandedPool) poolCard.append(poolSkillList(expandedPool));

  // --- condition (wound penalty folded in — it's derived straight from these tracks)
  const { raw: rawWound, negated: woundNegated, doubled: woundDoubled, dice: wound } = woundPenalty();
  const cond = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" }, el("h3", {}, "Condition"),
      el("span", {},
        counterBtn("Heal Stun", () => {
          play.stun_damage = 0; playChanged();
        }), " ",
        counterBtn("Full Heal", () => {
          play.physical_damage = 0; play.stun_damage = 0; playChanged();
        }, "good"))),
    conditionTrack("Physical", CALC.condition.physical,
      () => play.physical_damage, v => { play.physical_damage = v; }),
    conditionTrack("Stun", CALC.condition.stun,
      () => play.stun_damage, v => { play.stun_damage = v; }),
    el("p", { class: "hint", style: "margin:8px 0 0" },
      `Every 3 boxes marked on either track: ${woundDoubled ? "−2 dice" : "−1 die"} on tasks, `
      + "cumulative. Biotech can remove these penalties during combat."),
    el("div", { class: "stat-line", style: "margin-top:8px" },
      "Wound Penalty",
      el("b", { style: wound < 0 ? "color:var(--bad)" : "color:var(--ok)" },
        wound < 0 ? `${wound} dice` : "0")),
    // Soaking is Brawn out of the pool plus whatever soak dice you're owed, so
    // it opens the roller pointed at Brawn with those already in (issue #39).
    ro ? null : el("div", { class: "sh-counter-btns", style: "margin-top:8px" },
      el("button", { class: "btn",
        title: "Roll to soak — Brawn pool dice, plus any passive soak dice",
        onclick: () => openPoolRoller({ dice: 0, bonus: CALC.combat.soak_bonus || 0,
          pool: "Brawn", label: "Soak",
          note: (CALC.combat.soak_bonus ? `${CALC.combat.soak_bonus} passive soak dice — ` : "")
            + "dial in the Brawn you're spending" }) }, "⚄ Soak"),
      el("span", { class: "sub", style: "align-self:center" },
        CALC.combat.soak_bonus ? `+${CALC.combat.soak_bonus} soak dice` : "Brawn pool")),
    woundNegated
      ? el("div", { class: "sub", style: "color:var(--ok)" },
          rawWound < 0 ? `Negated — would be ${rawWound}` : "Wound penalties negated")
      : null,
    woundDoubled
      ? el("div", { class: "sub", style: "color:var(--bad)" },
          "Doubled by " + (CALC.combat.wound_penalty_doubled_by || "an augment")
          + (rawWound < 0 ? ` — would be ${rawWound}` : ""))
      : null,
    CALC.combat.physical_damage_reduction
      ? el("div", { class: "sub", style: "color:var(--ok)" },
          `Damage soak: −${CALC.combat.physical_damage_reduction} physical per hit (min 1) — Platelet Production Enhancement`)
      : null);

  // --- initiative + combat numbers
  // Initiative: roll Focus-pool dice, add Reaction — e.g. "12d+8". The Roll
  // button hands that pool to the die roller, which writes the result back
  // into the input below; the input stays directly editable either way.
  const init = sheetInitiative();
  const initInput = el("input", { type: "number", class: "sh-init-input",
    min: "0", value: String(play.initiative || 0),
    oninput: e => { play.initiative = parseInt(e.target.value, 10) || 0; playChanged(false); } });
  const initCard = el("div", { class: "card sh-card sh-counter" },
    el("h3", {}, "Initiative"),
    el("div", { class: "big" }, `${init.dice}d+${init.bonus}`),
    el("div", { class: "sub" }, "Focus Pool dice + Reaction"),
    ...(init.notes || []).map(n =>
      el("div", { class: "sub", style: "color:var(--amber);margin-top:4px" }, "★ " + n)),
    el("div", { class: "sh-counter-btns", style: "margin-top:8px" },
      el("button", { class: "btn sh-init-roll", title: "Roll initiative in the die roller",
        onclick: openInitiativeRoller }, "⚄ Roll"),
      el("span", { class: "sub", style: "align-self:center" }, "Rolled:"), initInput));

  const c = CALC.combat;
  const combatCard = el("div", { class: "card sh-card" },
    el("h3", {}, "Combat"),
    statLine("Move", `${c.move} m` + (moveSpecial() ? ` · ${moveSpecial()}` : "")),
    (c.move_modes && c.move_modes.length)
      ? statLine("Alt movement", c.move_modes.map(m => `${m.mode} ${m.meters}m`).join(" · ")) : null,
    statLine("Armor B / I", `${c.ballistic_armor} / ${c.impact_armor}`),
    statLine("Max B / Min I", `${c.max_ballistic} / ${c.min_impact}`),
    statLine("Recoil capacity",
      c.recoil_ignored ? `${c.recoil_capacity} · recoil ignored` : String(c.recoil_capacity)),
    c.martial_notes && c.martial_notes.length
      ? statLine("Martial art", c.martial_notes.join(" · ")) : null,
    // Active infusions: what was folded into the numbers above, so the Move /
    // Armor / pool figures don't look unexplained.
    (CALC.infusion_mods && CALC.infusion_mods.applied.length)
      ? statLine("Infusions applied",
          CALC.infusion_mods.applied.map(a => `${a.text} (${a.source})`).join(" · ")) : null,
    // Standing cover from martial arts and/or infusions — best tier wins. No
    // cover stat in the engine, so it's reported here and played at the table.
    c.cover ? statLine("Cover", c.cover.label, c.cover.sources.join(" · ")) : null,
    // A Shield-Wall Drone's mobile cover is the same kind of standing rider,
    // and belongs beside it rather than on the Rigging tab (issue #38).
    ...(c.drone_cover_notes || []).map(n => statLine("Cover (drone)", n.text, n.source)),
    // Bling: one line for the whole look, because a blinged gun and a blinged
    // ride are the same show — best single source, never the sum.
    ...(c.bling_etiquette || []).map(b => statLine(
      "Bling", `+${b.bonus} ${b.etiquette} Etiquette`,
      b.sources.length > 1
        ? `Best single source — bling doesn't stack: ${b.sources.join(" · ")}`
        : b.sources[0])),
    statLine("Simple actions", String(c.simple_actions)),
    ...exploitLines(c.exploit_actions),
    c.dodge_bonus ? statLine("Dodge bonus", `+${c.dodge_bonus}`, (c.dodge_sources || []).join(" · ")) : null,
    c.soak_bonus ? statLine("Soak bonus", `+${c.soak_bonus}`, (c.soak_sources || []).join(" · ")) : null,
    statLine("Carried weight", String(c.carried_weight)));
  // Dodging is a roll, not a counter, so this card has no number to stare at —
  // it works like Soak: a button that opens the roller pointed at Finesse with
  // your passive dodge dice already in, and a note saying how many those are.
  // (The big number was play.dodge_dice, a scratch value nothing ever wrote but
  // its own ±, so it sat at 0 forever and told you nothing.) Situational dice
  // (Full Defense, cover) are what the roller's own Bonus ± is for, and they
  // last exactly one roll, which is what "gained in play" always meant.
  const dodgeTracked = play.dodge_dice || 0;      // legacy hand-tracked dice, still counted
  const dodgeFree = (c.dodge_bonus || 0) + dodgeTracked;
  const dodgeRoll = () => openPoolRoller({ dice: 0, bonus: dodgeFree, pool: "Finesse",
    label: "Dodge",
    note: (dodgeFree ? `${dodgeFree} dodge dice free — ` : "")
      + "dial in the Finesse you're spending" });
  const dodgeCard = el("div", { class: "card sh-card sh-counter" },
    el("h3", {}, "Dodge"),
    el("div", { class: "sub" },
      (c.dodge_sources || []).length ? (c.dodge_sources || []).join(" · ")
        : "No passive dodge dice — dodging is Finesse out of the pool"),
    dodgeTracked
      ? el("div", { class: "sub", style: "color:var(--amber)" },
          `includes ${dodgeTracked} hand-tracked — clear it with the counter below`)
      : null,
    dodgeTracked && !ro
      ? miniCounter("Tracked dodge dice", () => play.dodge_dice || 0,
          v => { play.dodge_dice = v; }, 0, 99)
      : null,
    // A deployed drone whose rider is about dodging says so here, where you
    // roll it — a Shield Drone's "reroll 1s" is not a number the engine can add
    // to a pool, but it is a thing to remember at exactly this moment (#38).
    ...(c.drone_dodge_notes || []).map(n => el("div", { class: "sub", style: "color:var(--manon)" },
      `${n.text} (${n.source})`)),
    ro
      ? (dodgeFree ? el("div", { class: "sub" },
          `+${dodgeFree} dodge ${dodgeFree === 1 ? "die" : "dice"}`) : null)
      : el("div", { class: "sh-counter-btns", style: "margin-top:8px" },
          el("button", { class: "btn",
            title: `Roll to dodge — ${dodgeFree} free dodge ${dodgeFree === 1 ? "die" : "dice"}`
              + " plus whatever Finesse you spend",
            onclick: dodgeRoll }, "⚄ Dodge"),
          el("span", { class: "sub", style: "align-self:center" },
            dodgeFree ? `+${dodgeFree} dodge ${dodgeFree === 1 ? "die" : "dice"}`
                      : "Finesse pool")));

  // --- drones on station, sized to sit in the card flow beside Dodge Dice and
  // Combat rather than as a full-width band. The hotseat unit gets a compact
  // stat block (the full Unit|Stats|Attachments table is a Rigging-tab width);
  // every deployed unit's passive rider is listed under it.
  const onStation = deployedUnits();
  const stationCard = onStation.length
    ? (() => {
        const card = el("div", { class: "card sh-card" }, el("h3", {}, "Drones on Station"));
        const seat = onStation.find(d => d.hotseat);
        if (seat) {
          const cfg = RIG_UNIT_CFG[seat.table];
          const r = DATA.tables[seat.table].find(x => x[cfg.nameKey] === seat.u.name) || {};
          const { statMods } = unitAttachments(cfg, seat.u);
          const ball = toInt(r.Ballistic) + statMods.ballistic;
          const imp = toInt(r.Impact) + statMods.impact;
          const bodyMax = Math.max(0, toInt(r.Body) + statMods.body);
          const st = (CHAR.play.rigging.units || {})[unitStateKey(seat.table, seat.u)] || {};
          card.append(el("div", { class: "sh-h4", style: "margin:6px 0 2px" },
            (seat.u.label || seat.u.name),
            el("span", { class: "sh-tag", style: "margin-left:6px" }, "hotseat")));
          if (seat.u.label) card.append(el("div", { class: "sub" }, seat.u.name));
          // .filter(Boolean), not a bare append: Element.append() stringifies a
          // null argument into the literal word "null" on the page.
          card.append(...[
            statLine("Move", String(r.Move || "—")
              + (statMods.infusion_move ? ` +${statMods.infusion_move}m` : "")),
            statLine("Handling", String(r.Handling ?? "—")),
            statLine("Body", String(bodyMax) + (statMods.body ? ` (base ${r.Body})` : "")),
            (ball || imp) ? statLine("Armor B / I", `${ball} / ${imp}`) : null,
            statLine("Hardening", String(unitHardening(r, statMods))),
            bodyMax ? statLine("Damage",
              `${Math.min(toInt(st.physical), bodyMax)} phys · `
              + `${Math.min(toInt(st.integrity), bodyMax)} integrity`) : null,
            (seat.u.weapons || []).length
              ? statLine("Weapons", seat.u.weapons.map(sublistName).join(" · ")) : null,
          ].filter(Boolean));
        }
        const riders = onStation
          .map(d => ({ d, effect: unitPassiveEffect(d.table, d.u) }))
          .filter(x => x.effect);
        if (riders.length) {
          card.append(el("div", { class: "sh-h4", style: "margin:8px 0 2px" }, "Passive while deployed"));
          riders.forEach(({ d, effect }) => card.append(el("div", { class: "stat-line" },
            el("span", { class: "sub", style: "white-space:nowrap" }, d.u.label || d.u.name),
            el("span", { style: "text-align:right;color:var(--manon)" }, effect))));
        }
        if (!seat && !riders.length)
          card.append(el("p", { class: "hint" },
            `${onStation.length} deployed · none carries a passive effect. Tick `
            + "Hotseat on the Rigging tab to bring a unit's stats up here."));
        else if (riders.length)
          card.append(el("p", { class: "hint" }, "Applied at the table, not in the numbers above."));
        return card;
      })()
    : null;

  // --- martial arts combat effects: every unlocked level, grouped by style
  const maStylesWithLevels = (CALC.martial_arts || []).filter(m => m.levels.length);
  const maCard = maStylesWithLevels.length
    ? el("div", { class: "card sh-card" },
        el("h3", {}, "Martial Arts"),
        ...maStylesWithLevels.flatMap(m => [
          el("div", { class: "sh-h4", style: "margin:6px 0 2px" }, m.style),
          ...m.levels.map(lvl => el("div", { class: "stat-line" },
            el("span", { class: "sub", style: "white-space:nowrap" }, `L${lvl.Level}`),
            el("span", { style: "text-align:right" }, lvl.Effect || ""))),
        ]))
    : null;

  // --- active infusions: every placed spirit, marked by whether its effect was
  // folded into the derived stats or has to be applied situationally at the table.
  // An effect can be both (Moryana: "+2 Brawn Pool, +2 I armor" is fully in
  // stats; Terra Factorem's "+1 to I armor, +2d to melee attacks" is partly).
  const infusionList = CALC.infusions || [];
  const infCard = infusionList.length
    ? el("div", { class: "card sh-card" },
        el("h3", {}, "Speaker Infusions"),
        ...infusionList.map(inf => el("div", { class: "stat-line" },
          el("span", { class: "sub", style: "white-space:nowrap" },
            `${inf.slot} · ${inf.spirit}`),
          el("span", { style: "text-align:right" }, inf.effect || "—",
            el("span", { class: "sh-tag", style: "margin-left:6px" },
              infusionAppliedLabel(inf.spirit))))),
        el("p", { class: "hint" },
          "“In stats” effects are already counted in the numbers above. "
          + "“Situational” ones apply at the table — they can't be folded into a single figure."))
    : null;

  // Flat card list in a balanced multi-column flow (see .sh-ov-grid): columns
  // fill to equal height and reflow 3→2→1 by width, so no column is overloaded.
  body.append(el("div", { class: "sh-ov-grid" },
    ...[poolCard, cond, actionsCard(), maCard, infCard, initCard, dodgeCard,
        stationCard, combatCard].filter(Boolean)));

  // Heritage / uplift special abilities (e.g. a Bat's Echolocation) — surfaced
  // here on the Overview, not just buried on the Notes tab.
  const heritageCard = heritageTraitsCard();
  if (heritageCard) body.append(heritageCard);

  // --- equipped weapons (+ mods) and worn armor, mirrored from the Gear tab
  const weaponsAll = allWeapons(), armorAll = allArmor();
  const equippedWeapons = weaponsAll.filter(w => w.equipped !== false);
  const cyberguns = equippedCyberguns();
  const wornArmor = armorAll.filter(a => a.active !== false);
  const grantedWeapons = CALC.combat.granted_weapons || [];
  const traitGear = CALC.combat.trait_gear || [];
  // Ammo owned (chargen gear + anything bought in play), merged by name so one
  // ammo type reads as a single stack of uses. Ordered as the tables list it.
  const ammoOnHand = (() => {
    const byName = new Map();
    for (const g of allGear()) {
      const row = DATA.tables.misc_gear.find(x => x.Item === g.name);
      if (!row || !(row.Class || "").startsWith("Ammo")) continue;
      const seen = byName.get(g.name);
      if (seen) seen.uses += (g.qty || 0);
      else byName.set(g.name, { name: g.name, row, uses: g.qty || 0 });
    }
    return [...byName.values()];
  })();
  if (equippedWeapons.length || cyberguns.length || wornArmor.length
      || grantedWeapons.length || traitGear.length || ammoOnHand.length
      || (CALC.combat.armor_sources || []).length) {
    /* The dice you actually roll to attack with this weapon, shown next to its
     * type: rank in the mapped skill (CALC .final already folds in the untrained
     * group fallback, so Unarmed 4 shows Melee Weapons as 2) plus the weapon's
     * own Accuracy. Melee rows list Reach and carry no Accuracy, so those come
     * out as the bare skill. Returns null when nothing maps, so it can be
     * dropped straight into el(). */
    // A specialization is +1 on what it covers and −1 on everything else the
    // skill rolls, so it resolves per weapon rather than as the flat −1/+1 pair
    // the Skills tab shows. The chip shows the LIMIT (skill + Accuracy) beside
    // the free dice, because that's the line that matters: the limit comes out
    // of a pool and the bonus dice don't.
    const weaponSkillDice = (name, type, accuracy, bonuses = [], reach = null) => {
      const rs = weaponRollSpec(name, type, accuracy, bonuses, reach);
      if (!rs) return null;
      const { skill, limitDice, bonus, spec, why, bwhy } = rs;
      // The bladed cyber implants roll Cybertech Combat, which is trained only —
      // with no dice in it the weapon can't be used at all, so say so rather than
      // showing an Accuracy-only dice count that implies you can swing it.
      if (rs.locked)
        return el("b", { class: "wpn-dice locked",
          title: `${skill} is trained only — needs at least 1 die in the skill or its group` },
          "(trained only)");
      // Click the chip to load the roller: limit dice go in as skill dice (they
      // cost pool), free dice go in the bonus row.
      return rollable(el("span", { class: "wpn-dice-set" },
        el("b", { class: "wpn-dice" + (spec.delta ? (spec.delta > 0 ? " spec-on" : " spec-off") : ""),
          title: why.join(" ") }, `(${limitDice}d`),
        bonus
          ? el("b", { class: "wpn-bonus", title: `Bonus dice: ${bwhy.join(" + ")}` },
              ` +${bonus}b`)
          : null,
        el("b", { class: "wpn-dice" }, ")")),
        // Weapon name alone in the header — it's a panel title, and the skill
        // that made the number is one line down in the hint.
        { dice: limitDice, bonus, label: name, pool: rs.pool,
          note: `${skill}: ${rs.skillDice} skill`
            + (rs.acc ? ` + ${rs.acc} Accuracy` : "")
            + (bonus ? ` + ${bonus} bonus` : ""),
          title: `Roll ${limitDice + bonus}d6 — ${why.join(" ")}`
            + (bwhy.length ? `, bonus ${bwhy.join(" + ")}` : "") });
    };
    const loadout = el("div", { class: "card sh-card" }, el("h3", {}, "Loadout"));

    // Natural / implanted / power-granted weapons (Hand Razors, Spurs, Fangs,
    // Iron Fist, an Eye Laser) lead the Loadout: they're the things that are
    // always on you, can't be dropped or taken off you, and are what you're
    // left holding when everything else is gone. Damage and Reach are
    // Strength-derived, so they're computed rather than read off a row.
    if (grantedWeapons.length) {
      const gt = el("table");
      const gro = ro;
      gt.append(el("tr", {}, el("th", {}, "Natural / cyber weapon"),
        el("th", {}, "Stats"), el("th", {}, "Source"),
        gro ? null : el("th", {}, "")));
      // These are attacks made with the body, so they resolve against the
      // "Natural" pseudo-type (Unarmed Combat) unless weaponSkillName knows the
      // name -- the bladed implants roll Cybertech Combat instead.
      // `gw.stats` is a preformatted line (Snake's ranged Spit), so it's left be.
      // `gw.dice` is a fixed pool the implant supplies itself (Eye Laser): show
      // that number instead of asking for a skill rating it doesn't roll off,
      // and let `kind`/`note` replace the Melee/Reach framing that doesn't fit.
      grantedWeapons.forEach(gw => {
        const dice = gw.dice != null
          ? el("b", { class: "wpn-dice", title:
              `${gw.dice} dice — a fixed pool from the implant, not a skill rating` },
              `(${gw.dice}d)`)
          : weaponSkillDice(gw.name, "Natural", 0, [], gw.reach);
        // Same one-press roll the equipped weapons get, off whichever number
        // this row is showing: a skill rating for claws and blades, or the
        // implant's own fixed pool, which rolls off no skill and so spends none
        // of a pool unless you pick one in the roller.
        const rs = gw.dice != null
          ? { skillDice: Math.max(0, +gw.dice || 0), bonus: 0, pool: "", locked: false,
              skill: "", why: [`${gw.dice} dice from the implant`], bwhy: [] }
          : weaponRollSpec(gw.name, "Natural", 0, [], gw.reach);
        const attack = gro ? null : el("td", {},
          attackButton(gw.name, rs, gw.dice != null
            ? { note: `${gw.dice} dice — a fixed pool from the implant, not a skill rating`,
                title: `Roll ${gw.dice}d6 — fixed pool from ${gw.source}` }
            : {}));
        gt.append(el("tr", {},
          el("td", {}, el("b", {}, gw.name)),
          gw.stats
            ? el("td", { class: "sub" }, gw.stats)
            : el("td", { class: "sub" }, gw.kind || "Melee", dice,
                ` · DMG ${gw.damage}` + (gw.note ? ` · ${gw.note}` : ` · Reach ${gw.reach}`)),
          el("td", { class: "sub" }, gw.source),
          attack));
      });
      loadout.append(gt);
    }

    // Heavy Torso / No Head free-mount gear — weapons (with stats) and extra
    // limbs, each noting the granting trait. Bolted to the frame rather than
    // carried, so it sits with the natural weapons above the loadout proper.
    if (traitGear.length) {
      const tt = el("table");
      tt.append(el("tr", {}, el("th", {}, "Trait-mounted"),
        el("th", {}, "Stats"), el("th", {}, "From trait"),
        ro ? null : el("th", {}, ""), ro ? null : el("th", {}, "Ammo")));
      traitGear.forEach(g => {
        const w = g.weapon;
        // A mounted gun loads from the same stock as anything else you own, and
        // what's in it moves its numbers — so resolve the round before building
        // the stat line, the way the equipped weapons do.
        const mountEntry = (g.kind === "weapon" && w) ? traitMountState(g.label) : null;
        const mAmmo = mountEntry ? loadedAmmoFor(mountEntry, w)
                                 : { row: null, name: "", mods: null, notes: [] };
        const mBase = w ? { acc: w.Accuracy || 0, damage: w.Damage || "—",
                            pen: w.Pen || 0, bar: String(w.Bar ?? "") } : null;
        const mShot = (mBase && mAmmo.row) ? RULES.applyAmmoStats(mBase, mAmmo.mods) : mBase;
        const mBit = (label, key) => el("span",
          (mAmmo.row && String(mShot[key]) !== String(mBase[key]))
            ? { class: "wpn-ammo-mod", title: `${mAmmo.name} loaded` } : {},
          `${label} ${mShot[key]}`);
        const stats = g.kind === "weapon" && w
          ? [`${w.Type || ""}`, weaponSkillDice(w.Weapon, w.Type, mShot.acc, [], w.Reach),
             " · ", mBit("Acc", "acc"), " · ", mBit("DMG", "damage"),
             " · ", mBit("Pen", "pen"),
             mBase.bar ? " · " : "", mBase.bar ? mBit("Barrier", "bar") : "",
             ` · Conceal ${w.Conceal || 0} · wt ${w.Weight || 0}`,
             mAmmo.notes.length
               ? el("div", { class: "sub wpn-ammo-note" },
                   `${mAmmo.name}: ${mAmmo.notes.join(" · ")}`) : null]
          : ["Extra limb (free mount)"];
        // A mounted gun runs a magazine like any other, off its own weapon row's
        // Ammo and Firing modes. Trait gear is derived fresh every recalc from
        // the heritage picks, so there's no entry to hang the round count on —
        // it lives in play state keyed by the mount's label instead. A mounted
        // blade has no modes and keeps the plain Attack; an extra limb is a
        // mount rather than a weapon and gets nothing to press.
        const modes = (g.kind === "weapon" && w) ? RULES.weaponFiringModes(w) : [];
        const mount = mountEntry;
        const mMode = modes.includes(mount && mount.mode) ? mount.mode : (modes[0] || "");
        const mMd = mMode ? RULES.firingMode(mMode) : { dice: 0, ammo: 0 };
        const mMag = Math.max(0, parseInt(w && w.Ammo, 10) || 0);
        const mKata = gunKataRank() >= 2 && mMag > 0 && modes.length > 0;
        const mBonuses = [];
        if (mMd.dice) mBonuses.push({ label: mMode, dice: mMd.dice });
        if (mKata && mount && mount.kata) mBonuses.push({ label: "Gun-Kata", dice: 1 });
        const rs = (g.kind === "weapon" && w)
          ? weaponRollSpec(w.Weapon, w.Type, mShot.acc, mBonuses, w.Reach) : null;
        const attack = ro ? null : el("td", {},
          (modes.length && mount)
            ? firingModeControls(mount, w, {}, modes, mMode, mKata, rs, g.label)
            : (g.kind === "weapon" && w) ? attackButton(g.label, rs) : "—");
        // Loads from the same stock as everything else — a mount is a gun, not
        // a special case. Melee mounts and limbs take nothing, so they say so.
        const ammoCell = ro ? null : el("td", { class: "sub" },
          mount ? munitionPicker(mount, w) : "—");
        tt.append(el("tr", {},
          el("td", {}, el("b", {}, g.label)),
          el("td", { class: "sub" }, ...stats),
          el("td", { class: "sub" }, g.source),
          attack, ammoCell));
      });
      loadout.append(tt);
    }

    if (equippedWeapons.length || cyberguns.length) {
      const wt = el("table", { class: "sh-loadout" });
      // Mods are listed by name inside the stat line rather than getting a
      // column of their own -- their full effect text is on the Gear tab -- so
      // the freed columns can carry the firing mode and the loaded ammo.
      wt.append(el("tr", {}, el("th", {}, "Equipped weapon"), el("th", {}, "Stats"),
        el("th", {}, "Fire mode"), el("th", {}, "Ammo")));
      // Weapons and cyberguns share ONE ordered list so a cybergun can sit
      // anywhere among the weapons (order stored as `lo` on each backing object).
      const items = [];
      equippedWeapons.forEach((w, idx) => items.push({
        ins: idx, getOrder: () => w.lo, setOrder: v => { w.lo = v; },
        cells: () => {
          const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
          const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
          // Names only -- the full effect text lives on the Gear tab.
          const modNames = [...(w.mods || [])];
          if (w.upgr1 && r.Upgr1_Eff) modNames.push("Upgrade 1");
          if (w.upgr2 && r.Upgr2_Eff) modNames.push("Upgrade 2");
          const modes = RULES.weaponFiringModes(r);
          const mode = modes.includes(w.mode) ? w.mode : (modes[0] || "");
          const md = mode ? RULES.firingMode(mode) : { dice: 0, ammo: 0, name: "" };
          // What's loaded shifts the numbers the line reports, so resolve it
          // before building the stats rather than annotating afterwards. A
          // grenade launcher takes its Damage, Pen and Barrier wholesale from
          // the chambered grenade -- its own Damage column just says "By
          // Grenade" and it carries no Barrier rating of its own.
          const baseAcc = calcRow.Accuracy ?? r.Accuracy ?? 0;
          // Thrown weapons skip the melee damage pass, so a Knife would print
          // "½ Str" rather than the number it resolves to.
          let baseDmg = calcRow.Damage ?? r.Damage ?? "—";
          if (RULES.isStrengthDamage(baseDmg) && RULES.meleeDamageIsComputable(baseDmg))
            baseDmg = RULES.meleeDamage(r, CALC.attributes.Strength.final);
          const isLauncher = r.Type === "GrenadeLauncher";
          const base = { acc: baseAcc, damage: baseDmg, pen: r.Pen || 0,
                         bar: String(calcRow.Bar ?? r.Bar ?? "") || (isLauncher ? "—" : "") };
          // Melee, thrown and energy weapons load nothing, so they must not pick
          // up the default Standard round.
          const canLoad = !["Melee", "Thrown", "Energy"].includes(r.Type);
          const gren = isLauncher ? loadedGrenadeFor(w) : null;
          const ammo = (isLauncher || !canLoad)
            ? { row: null, name: "", notes: [] } : loadedAmmoFor(w, r);
          const munName = isLauncher ? gren.name : ammo.name;
          const munNotes = isLauncher ? gren.notes : ammo.notes;
          const shot = isLauncher
            ? (gren.row ? { acc: baseAcc, damage: gren.row.Damage || "—", pen: gren.row.Pen || 0,
                            bar: String(gren.row.Bar ?? "") || "—" }
                        : { ...base })
            : (ammo.row ? RULES.applyAmmoStats(base, ammo.mods) : { ...base });
          // Gun-Kata 2 buys an extra bullet: +1 die for 1 more round. Opt-in per
          // weapon, and only offered to a gun that actually feeds from a magazine.
          const magSize = Math.max(0, parseInt(calcRow.Ammo ?? r.Ammo, 10) || 0);
          const kataOffered = gunKataRank() >= 2 && magSize > 0 && modes.length > 0;
          const kataOn = kataOffered && !!w.kata;
          const bonuses = [];
          if (md.dice) bonuses.push({ label: mode, dice: md.dice });
          if (kataOn) bonuses.push({ label: "Gun-Kata", dice: 1 });
          const statBit = (label, key) => el("span",
            (munName && String(shot[key]) !== String(base[key]))
              ? { class: "wpn-ammo-mod", title: `${munName} loaded` } : {},
            `${label} ${shot[key]}`);
          return {
            name: el("b", {}, w.name + ((calcRow.smart ?? w.smart) ? " (smart)" : "")),
            stats: el("td", { class: "sub" },
              // Mirror the full Gear-tab stat line (issue #15): rate of fire /
              // Reach, ZR, Weight, Hardening, Rarity all included.
              `${r.Type || ""}`,
              weaponSkillDice(w.name, r.Type, shot.acc, bonuses, r.Reach),
              " · ",
              r.Type === "Melee" ? `Reach ${r.Reach || 0}` : statBit("Acc", "acc"),
              " · ", statBit("DMG", "damage"), " · ", statBit("Pen", "pen"),
              // Omitted where the weapon has no Barrier rating at all, so a
              // melee line doesn't gain a meaningless "Barrier 0".
              base.bar ? " · " : null, base.bar ? statBit("Barrier", "bar") : null,
              ` · Conceal ${r.Conceal || 0} · ZR ${r.ZR || 0} · Weight ${r.Weight || 0}`
              + ((calcRow.Ammo ?? r.Ammo) ? ` · Mag ${calcRow.Ammo ?? r.Ammo}` : "")
              + ` · Hardening ${RULES.hardeningOf(r)}`
              + (r.Rarity && r.Rarity !== "-" ? ` · Rarity ${r.Rarity}` : ""),
              modNames.length
                ? el("div", { class: "sub wpn-mods" }, "Mods: " + modNames.join(" · ")) : null,
              munNotes.length
                ? el("div", { class: "sub wpn-ammo-note" }, `${munName}: ${munNotes.join(" · ")}`) : null),
            fire: el("td", { class: "sub" }, (() => {
              const rs = weaponRollSpec(w.name, r.Type, shot.acc, bonuses, r.Reach);
              if (modes.length)
                return firingModeControls(w, r, calcRow, modes, mode, kataOffered, rs);
              // Melee, thrown and anything else without a firing mode: no
              // magazine to track, but the same attack test to roll.
              const ro = !!(activeTabObj() && activeTabObj().readonly);
              return ro ? "—" : attackButton(w.name, rs);
            })()),
            ammo: el("td", { class: "sub" }, munitionPicker(w, r)),
          };
        },
      }));
      cyberguns.forEach((cg, idx) => items.push({
        ins: 1000 + idx, getOrder: () => cg.src.lo, setOrder: v => { cg.src.lo = v; },
        cells: () => {
          const g = cg.gun;
          // A cybergun loads ammo and runs a magazine like any other firearm —
          // the implant states its own Ammo and Modes. Both the choice and the
          // round count live on the source augment entry, since the gun row
          // itself is shared data.
          const cgRow = { Type: "Cybergun", Weapon: cg.name, Damage: g.Dmg, Ammo: g.Ammo };
          const ammo = loadedAmmoFor(cg.src, cgRow);
          const base = { acc: g.Acc, damage: g.Dmg, pen: g.Pen, bar: g.Bar ?? "" };
          const shot = RULES.applyAmmoStats(base, ammo.mods);
          const cgModes = RULES.weaponFiringModes(g);
          const cgMode = cgModes.includes(cg.src.mode) ? cg.src.mode : (cgModes[0] || "");
          const cgMd = cgMode ? RULES.firingMode(cgMode) : { dice: 0, ammo: 0 };
          const cgMag = Math.max(0, parseInt(g.Ammo, 10) || 0);
          const cgKataOffered = gunKataRank() >= 2 && cgMag > 0 && cgModes.length > 0;
          const cgBonuses = [];
          if (cgMd.dice) cgBonuses.push({ label: cgMode, dice: cgMd.dice });
          if (cgKataOffered && cg.src.kata) cgBonuses.push({ label: "Gun-Kata", dice: 1 });
          const bit = (label, key) => el("span",
            (ammo.row && String(shot[key]) !== String(base[key]))
              ? { class: "wpn-ammo-mod", title: `${ammo.name} ammo` } : {},
            `${label} ${shot[key]}`);
          return {
            name: el("b", {}, cg.name + " (smart)"),
            stats: el("td", { class: "sub" },
              "Cybergun", weaponSkillDice(cg.name, "Cybergun", shot.acc, cgBonuses),
              " · ", bit("Acc", "acc"), " · ", bit("DMG", "damage"), " · ", bit("Pen", "pen"),
              base.bar ? " · " : null, base.bar ? bit("Barrier", "bar") : null,
              ` · Mag ${g.Ammo}`,
              el("div", { class: "sub wpn-mods" }, "Implanted — configured on the Augments tab"),
              ammo.notes.length
                ? el("div", { class: "sub wpn-ammo-note" }, `${ammo.name}: ${ammo.notes.join(" · ")}`) : null),
            fire: el("td", { class: "sub" }, cgModes.length
              ? firingModeControls(cg.src, cgRow, {}, cgModes, cgMode, cgKataOffered,
                  weaponRollSpec(cg.name, "Cybergun", shot.acc, cgBonuses), cg.name)
              : "—"),
            ammo: el("td", { class: "sub" }, munitionPicker(cg.src, cgRow)),
          };
        },
      }));
      loadoutSort(items);
      items.forEach((it, i) => {
        const c = it.cells();
        const handle = reorderHandle(() => loadoutMove(items, i, -1), () => loadoutMove(items, i, 1),
          i > 0, i < items.length - 1);
        wt.append(el("tr", {}, el("td", {}, handle, c.name), c.stats, c.fire, c.ammo));
      });
      loadout.append(wt);
      // A weapon you own but haven't equipped is absent from this table, which
      // reads as the sheet having lost it. Name them, and say where to fix it.
      const stowed = weaponsAll.filter(w => w.equipped === false);
      if (stowed.length) {
        loadout.append(el("p", { class: "hint" },
          `Not equipped, so not listed above: ${stowed.map(w => w.name).join(" · ")}. `
          + `Tick Equip on the Gear tab to carry ${stowed.length > 1 ? "them" : "it"}.`));
      }
    }
    // Ammo on hand, listed under the weapons it feeds (issue #21). Uses remaining
    // are tracked on the Gear tab; Effect/Notes come straight from the table.
    if (ammoOnHand.length) {
      const amt = el("table");
      amt.append(el("tr", {}, el("th", {}, "Ammo"), el("th", { class: "num" }, "Uses"),
        el("th", {}, "Effect / restrictions")));
      ammoOnHand.forEach(a => amt.append(el("tr", {},
        el("td", {}, el("b", {}, a.name)),
        el("td", { class: "num" }, String(a.uses)),
        el("td", { class: "sub" }, [a.row.Effect || "", a.row.Notes || ""]
          .filter(Boolean).join(" · ") || "—"))));
      loadout.append(amt);
    }
    // (Both the natural / cyber and trait-mounted tables are built and appended
    // above the equipped weapons — what's part of you, then what's bolted to
    // you, then what you picked up.)
    const armorSources = CALC.combat.armor_sources || [];
    if (wornArmor.length || armorSources.length) {
      // Worn armor + granted (cyber/bioware/heritage/amp) armor share ONE ordered
      // list. Worn order lives on the armor object (`lo`); granted rows are derived
      // each recalc, so their order is stored by source name in a play-state map.
      const gmap = (CHAR.play.granted_armor_order = CHAR.play.granted_armor_order || {});
      const at = el("table");
      at.append(el("tr", {}, el("th", {}, "Armor"), el("th", { class: "num" }, "B / I"),
        el("th", {}, "Notes")));
      const items = [];
      wornArmor.forEach((a, idx) => items.push({
        ins: idx, getOrder: () => a.lo, setOrder: v => { a.lo = v; },
        cells: () => {
          const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
          // Match the Gear tab: Quality/Style/slot, weight, extras -- then the
          // gameplay effects those carry (issue #18). wornArmor is a filtered
          // view, so map back through the full owned list to reach the CALC row.
          const arow = (CALC.armor || [])[armorAll.indexOf(a)] || {};
          const notes = [
            [arow.material, arow.style].filter(Boolean).join(" · ") || r.Slot || "",
            `wt ${r.wt || 0}`,
            (arow.extras || []).length ? arow.extras.join(", ") : "",
          ].filter(Boolean).join(" · ");
          const aeffects = arow.effects || [];
          return {
            name: el("b", {}, a.name),
            stats: el("td", { class: "num" }, `${r.Ballistic || 0} / ${r.Impact || 0}`),
            last: el("td", { class: "sub" }, notes || "—",
              aeffects.length ? el("div", { class: "armor-effects" },
                aeffects.map(e => `${e.label}: ${e.text}`).join(" · ")) : null),
          };
        },
      }));
      armorSources.forEach((s, idx) => items.push({
        ins: 1000 + idx, getOrder: () => gmap[s.name], setOrder: v => { gmap[s.name] = v; },
        cells: () => ({
          name: el("span", {}, el("b", {}, s.name), el("span", { class: "sh-tag" }, "granted")),
          stats: el("td", { class: "num" }, `${s.b} / ${s.i}`),
          last: el("td", { class: "sub" }, s.unstrippable ? "unstrippable" : "—"),
        }),
      }));
      loadoutSort(items);
      items.forEach((it, i) => {
        const c = it.cells();
        const handle = reorderHandle(() => loadoutMove(items, i, -1), () => loadoutMove(items, i, 1),
          i > 0, i < items.length - 1);
        at.append(el("tr", {}, el("td", {}, handle, c.name), c.stats, c.last));
      });
      // One selector per slot the character owns armor for, so changing what
      // you're wearing is a single click here rather than a trip to the Gear
      // tab to untick one box and tick another. Picking a piece takes off
      // whatever else was in that slot — the same one-piece-per-slot rule the
      // Worn checkbox enforces — and a Helmet keeps its own slot ("Outer*"),
      // which is why it can be worn alongside a coat.
      const SLOT_LABELS = { Outer: "Outer", Under: "Under", "Outer*": "Helmet" };
      const armorSwap = (() => {
        if (ro || !armorAll.length) return null;
        const bySlot = new Map();
        armorAll.forEach((a, i) => {
          const slot = (DATA.tables.armor.find(x => x.Armor === a.name) || {}).Slot || "Other";
          if (!bySlot.has(slot)) bySlot.set(slot, []);
          bySlot.get(slot).push({ a, i });
        });
        const order = ["Outer", "Under", "Outer*"];
        const slots = [...bySlot.keys()]
          .sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
        const row = el("div", { class: "sh-armor-swap" });
        for (const slot of slots) {
          const group = bySlot.get(slot);
          const worn = group.find(({ a }) => a.active !== false);
          const sel = el("select", { class: "sh-fire-sel",
            title: `What you're wearing in the ${SLOT_LABELS[slot] || slot} slot`,
            onchange: async e => {
              const pick = e.target.value === "" ? -1 : +e.target.value;
              group.forEach(({ a, i }) => { a.active = (i === pick); });
              await playChangedRecalc();
            } },
            el("option", { value: "" }, "— nothing —"),
            ...group.map(({ a, i }) => {
              const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
              const arow = (CALC.armor || [])[i] || {};
              // Style and Quality distinguish four otherwise identical coats.
              const trim = [arow.style, arow.material].filter(Boolean).join(" · ");
              return el("option", { value: String(i),
                ...(worn && worn.i === i ? { selected: 1 } : {}) },
                `${a.name}${trim ? ` (${trim})` : ""} — ${r.Ballistic || 0}/${r.Impact || 0}`);
            }));
          sel.value = worn ? String(worn.i) : "";
          row.append(el("label", { class: "sub sh-armor-swap-slot" },
            el("span", {}, SLOT_LABELS[slot] || slot), sel));
        }
        return row;
      })();
      loadout.append(...[
        el("div", { class: "sh-advrow", style: "border:0;padding:6px 0 0" },
          el("span", { class: "sub" },
            `Total armor: ${CALC.combat.ballistic_armor}B / ${CALC.combat.impact_armor}I`)),
        armorSwap,
        at,
      ].filter(Boolean));
      // Sits directly under the total it inflates, so the number and the reason
      // it's wrong are read together.
      for (const { slot, names } of overArmoredSlots()) {
        loadout.append(el("div", { class: "sh-callout warn" }, "⚠ ",
          el("b", {}, `${names.length} ${slot} pieces worn — `),
          `only one ${slot} piece should count, but all ${names.length} are adding to the `
          + `totals above: ${names.join(" · ")}. Untick the extras under Worn on the Gear tab.`));
      }
    }
    body.append(loadout);
  }

  // --- temporary effects + active modifiers
  body.append(el("div", { class: "sh-two" },
    trackedList("Temporary Effects", play.effects, "Add Effect",
      () => {
        const name = (prompt("Effect name (e.g. Haste F4, 3 rounds):") || "").trim();
        if (name) { play.effects.push({ name }); playChanged(); }
      },
      e2 => e2.name, "No temporary effects tracked."),
    trackedList("Active Modifiers", play.modifiers, "Add Modifier",
      () => {
        const name = (prompt("Modifier name (e.g. Cover, Smartlink):") || "").trim();
        if (!name) return;
        const v = (prompt("Value (e.g. +2, −1d):", "+1") || "").trim();
        play.modifiers.push({ name, value: v }); playChanged();
      },
      m => m.value ? `${m.name}  ${m.value}` : m.name, "No active modifiers tracked.")));

  // --- notes
  body.append(notesCard(3));
}

function statLine(label, value, title) {
  return el("div", title ? { class: "stat-line", title } : { class: "stat-line" },
    label, el("b", {}, value));
}
// Exploit actions (CALC.combat.exploit_actions), grouped by kind into one line
// each — Melee / Move / Decking / Rigging / Control — with the granting sources
// listed beneath the total (rules #1–7). Empty kinds are omitted.
const EXPLOIT_KIND_ORDER = ["Melee", "Move", "Decking", "Rigging", "Control"];
function exploitLines(actions) {
  const byKind = {};
  for (const a of actions || []) {
    const g = (byKind[a.kind] = byKind[a.kind] || { total: 0, items: [] });
    g.total += a.count;
    g.items.push(a);
  }
  return EXPLOIT_KIND_ORDER.filter(k => byKind[k]).map(k => {
    const g = byKind[k];
    // Show each source's own count only when several sources share a kind — a
    // lone source's count already equals the line total, so "(+n)" is noise.
    const sources = g.items.map(a =>
      g.items.length > 1 && a.count > 1 ? `${a.source} (+${a.count})` : a.source);
    return el("div", { class: "stat-line" },
      el("span", {}, `${k} exploit`),
      el("span", { style: "text-align:right" },
        el("b", {}, `+${g.total}`),
        el("div", { class: "sub", style: "font-weight:400" }, sources.join(" · "))));
  });
}
/* What a round costs you, tracked as it's spent (issue #32).
 *
 * Actions come from the engine — `simple_actions` plus the exploit actions each
 * source grants — so only the SPENT count is play state, keyed by "simple" or
 * the exploit kind. Everything derived stays derived: gain an exploit mid-play
 * and the total moves on its own.
 *
 * New Round (issue #37) is here rather than in the header because it belongs
 * with what it clears: every pool back to full and every action unspent, which
 * between them is what a fresh round actually means. */
function actionsCard() {
  const play = CHAR.play;
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const used = (play.actions_used = play.actions_used || {});
  const rows = [{ key: "simple", label: "Simple", total: CALC.combat.simple_actions || 0 }];
  const byKind = {};
  for (const a of CALC.combat.exploit_actions || [])
    byKind[a.kind] = (byKind[a.kind] || 0) + a.count;
  for (const kind of EXPLOIT_KIND_ORDER)
    if (byKind[kind]) rows.push({ key: kind, label: `${kind} exploit`, total: byKind[kind] });

  const card = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" }, el("h3", {}, "Actions This Round"),
      ro ? null : counterBtn("↻ New Round", () => {
        for (const p of POOL_ORDER) poolState(p).setUsed(0);
        CHAR.play.actions_used = {};
        playChanged();
      }, "good")));
  for (const r of rows) {
    const spent = Math.max(0, Math.min(used[r.key] || 0, r.total));
    const left = r.total - spent;
    card.append(el("div", { class: "stat-line" + (left ? "" : " dim") },
      el("span", {}, r.label),
      el("span", { style: "text-align:right;display:inline-flex;align-items:center;gap:8px" },
        el("b", { style: left ? "" : "color:var(--dim)" }, `${left} / ${r.total}`),
        ro ? null : miniCounter("", () => used[r.key] || 0,
          v => { used[r.key] = v; }, 0, r.total))));
  }
  card.append(el("p", { class: "hint" },
    "Spent actions and pool dice both clear on New Round. Totals come from your "
    + "build, so anything that grants an exploit shows up here on its own."));
  return card;
}

function miniCounter(label, get, set, min = 0, max = 9999) {
  const clamp = n => Math.max(min, Math.min(max, n));
  const val = el("b", { title: "Click to type a value", style: "cursor:text" }, String(get()));
  val.addEventListener("click", () => {
    const input = el("input", { type: "number", value: String(get()),
      min: String(min), max: String(max), class: "sv-edit", style: "width:56px" });
    val.replaceWith(input); input.focus(); input.select();
    let done = false;
    const commit = save => {
      if (done) return; done = true;
      if (save) {
        const n = parseInt(input.value, 10);
        if (Number.isFinite(n)) { set(clamp(n)); val.textContent = String(get()); }
      }
      input.replaceWith(val);
      if (save) playChanged();
    };
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
  });
  return el("span", { class: "sh-mini" },
    el("span", { class: "lbl" }, label),
    el("button", { class: "mini-btn", onclick: () => { set(clamp(get() - 1)); playChanged(); } }, "−"),
    val,
    el("button", { class: "mini-btn", onclick: () => { set(clamp(get() + 1)); playChanged(); } }, "+"));
}

function conditionTrack(label, max, get, set) {
  const filled = Math.min(get(), max);
  const boxes = el("div", { class: "sh-boxes" });
  for (let i = 1; i <= max; i++) {
    boxes.append(el("button", {
      class: "sh-box" + (i <= filled ? " filled" : "") + (label === "Stun" ? " stun" : ""),
      "aria-label": `${label} box ${i}`,
      onclick: () => { set(i === filled ? i - 1 : i); playChanged(); },
    }, String(i)));
  }
  return el("div", { class: "sh-track" },
    el("div", { class: "sh-track-head" },
      el("span", { class: label === "Stun" ? "stun-lbl" : "phys-lbl" }, label.toUpperCase()),
      el("span", { class: "sub" }, `${filled} / ${max}`)),
    boxes);
}

function trackedList(title, items, addLabel, onAdd, describe, emptyText) {
  const card = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, title, " ", el("span", { class: "chip" }, String(items.length))),
      counterBtn(addLabel, onAdd, "accent")));
  if (!items.length) card.append(el("p", { class: "hint", style: "margin:6px 0 0" }, emptyText));
  items.forEach((it, i) => card.append(el("div", { class: "stat-line" },
    describe(it),
    el("button", { class: "row-del", onclick: () => { items.splice(i, 1); playChanged(); } }, "✕"))));
  return card;
}

function notesCard(rows) {
  const ta = el("textarea", { class: "sh-notes", rows: String(rows || 6),
    placeholder: "Character notes, session logs, reminders…",
    oninput: e => { CHAR.play.notes = e.target.value; playChanged(false); } });
  ta.value = CHAR.play.notes || "";
  return el("div", { class: "card sh-card" },
    el("h3", {}, "Notes"),
    el("p", { class: "hint", style: "margin:2px 0 8px" }, "Notes save automatically while you type."),
    ta);
}

/* ---- character images (portrait, crest, …) --------------------------------
 * Stored on the character as data URLs, so a picture travels with a save, a
 * cloud sync and a JSON export instead of living only on one device. The cost
 * is that images share the server's 256 KB per-character payload cap
 * (read_json_body in api/lib.php rejects anything bigger with a 413), so
 * everything here exists to keep a save from ever being refused: uploads are
 * downscaled and re-encoded, and the running total is checked before storing. */
const IMAGE_MAX_EDGE = 512;      // longest side, px — plenty for a sheet portrait
const IMAGE_MAX_COUNT = 6;
const IMAGE_BUDGET = 180 * 1024; // total data-URL chars across all images
const imageBytes = url => (url || "").length;
const imagesUsed = () => (CHAR.play.images || []).reduce((n, im) => n + imageBytes(im.url), 0);
const fmtKB = n => `${Math.round(n / 1024)} KB`;

/* Downscale + re-encode a picked file, returning { url, bytes, flattened }.
 * `room` is how many data-URL chars are still available.
 *
 * Transparency only survives PNG, and PNG of a photo is enormous, so the format
 * follows the image: alpha means a logo, no alpha means a picture. A big
 * transparent logo shrinks — still as PNG — before transparency is given up,
 * because a smaller crest beats a crest with a rectangle of background behind
 * it. Only when no PNG size fits does it flatten to JPEG, and it says so.
 * Rejects with a message fit to show the user. */
function prepareImage(file, room) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Couldn't read that file."));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error(`${file.name} isn't an image this browser can read.`));
      img.onload = () => {
        const draw = edge => {
          const scale = Math.min(1, edge / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas;
        };
        const full = draw(IMAGE_MAX_EDGE);
        const px = full.getContext("2d").getImageData(0, 0, full.width, full.height).data;
        let hasAlpha = false;
        for (let i = 3; i < px.length; i += 4) { if (px[i] < 255) { hasAlpha = true; break; } }

        const fits = url => imageBytes(url) <= room;
        let best = null;                       // smallest thing we produced, for the error
        const consider = (url, flattened) => {
          if (!best || imageBytes(url) < imageBytes(best.url)) best = { url, flattened };
          return fits(url) ? { url, bytes: imageBytes(url), flattened } : null;
        };
        if (hasAlpha) {
          for (const edge of [IMAGE_MAX_EDGE, 384, 256, 160]) {
            const hit = consider(draw(edge).toDataURL("image/png"), false);
            if (hit) { resolve(hit); return; }
          }
        }
        for (const edge of [IMAGE_MAX_EDGE, 384, 256]) {
          const canvas = draw(edge);
          for (const q of [0.82, 0.7, 0.58, 0.46]) {
            const hit = consider(canvas.toDataURL("image/jpeg", q), hasAlpha);
            if (hit) { resolve(hit); return; }
          }
        }
        reject(new Error(`${file.name} won't fit — needs at least `
          + `${fmtKB(imageBytes(best.url))}, ${fmtKB(Math.max(0, room))} free. `
          + `Remove an image first.`));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function imagesCard() {
  CHAR.play.images = CHAR.play.images || [];
  const list = CHAR.play.images;
  const used = imagesUsed();
  const card = el("div", { class: "card sh-card" }, el("h3", {}, "Images"));
  card.append(el("p", { class: "hint", style: "margin:2px 0 8px" },
    `Portrait, crest, gang logo — up to ${IMAGE_MAX_COUNT}. Saved with the character, `
    + `so they sync and travel in an export. Large files are scaled to `
    + `${IMAGE_MAX_EDGE}px and re-compressed to stay inside the size limit.`));

  const grid = el("div", { class: "sh-imgs" });
  list.forEach((im, i) => {
    const shot = el("img", { class: "sh-img" + (im.big ? " big" : ""), src: im.url,
      alt: im.caption || "Character image", title: "Click to enlarge",
      onclick: () => { im.big = !im.big; playChanged(); } });
    const cap = el("input", { type: "text", placeholder: "Caption…",
      oninput: e => { im.caption = e.target.value; playChanged(false); } });
    cap.value = im.caption || "";
    grid.append(el("div", { class: "sh-img-cell" }, shot,
      el("div", { class: "sh-img-foot" }, cap,
        el("button", { class: "row-del", title: "Remove this image",
          onclick: () => { list.splice(i, 1); playChanged(); } }, "✕")),
      el("div", { class: "sub" }, fmtKB(imageBytes(im.url)))));
  });
  if (list.length) card.append(grid);

  const status = el("div", { class: "hint" },
    `${list.length} / ${IMAGE_MAX_COUNT} images · ${fmtKB(used)} of ${fmtKB(IMAGE_BUDGET)} used`);
  const picker = el("input", { type: "file", accept: "image/*", multiple: "1",
    style: "display:none",
    onchange: async e => {
      const files = [...e.target.files];
      e.target.value = "";                     // so the same file can be re-picked
      const notes = [];
      for (const file of files) {
        if ((CHAR.play.images || []).length >= IMAGE_MAX_COUNT) {
          notes.push(`Stopped at ${IMAGE_MAX_COUNT} images.`); break;
        }
        try {
          const out = await prepareImage(file, IMAGE_BUDGET - imagesUsed());
          CHAR.play.images.push({ url: out.url, caption: file.name.replace(/\.[^.]+$/, "") });
          if (out.flattened) notes.push(`${file.name}: transparency flattened to fit.`);
        } catch (err) { notes.push(err.message); }
      }
      if (notes.length) alert(notes.join("\n"));
      playChanged();
    } });
  const addBtn = el("button", { class: "btn-add",
    disabled: list.length >= IMAGE_MAX_COUNT ? "1" : null,
    onclick: () => picker.click() },
    list.length >= IMAGE_MAX_COUNT ? "Limit reached" : "Add image…");
  card.append(el("div", { class: "sh-advrow", style: "border:0;padding:8px 0 0" },
    status, addBtn), picker);
  return card;
}

/* skills belonging to one pool — shown when its pool card is clicked */
// Shared skill-breakdown table, used by both the Skills tab and the pool-chip
// expansion on the Overview so the two stay in lockstep. Columns read left to
// right as Base (Pts) + Bonus + Group = Final dice.
function skillTableHeader() {
  return el("tr", {}, el("th", {}, "Skill"), el("th", { class: "num" }, "Pts"),
    el("th", { class: "num" }, "Bonus"), el("th", { class: "num" }, "Group"),
    el("th", { class: "num" }, "Final"));
}

// `bareName` drops the Trained Only chip: the locked block below carries the
// label on its section header, so repeating it on every row is pure noise.
function skillTableRow(name, dim = false, editable = false, bareName = false) {
  const s = CALC.skills[name];
  CHAR.skill_specializations ??= {};
  const spec = CHAR.skill_specializations[name];
  const specOn = !!(spec && spec.on) && s.final > 0;
  const rating = specOn ? `${s.final - 1} / ${s.final + 1}`
    : s.final > 0 ? String(s.final)
    : s.dice_bonus ? "0" : "—";
  // group_value already folds the bonus in; the Group column shows just the
  // group-derived dice so Pts + Bonus + Group reads as Final.
  const groupDice = s.points === 0 && s.group_value != null ? s.group_value - s.bonus : 0;

  // Inline chips that sit beside the name. The Trained Only marker goes on every
  // view (read-only and untrained rows included) -- it's needed most exactly when
  // the skill is unusable -- and turns amber once the character genuinely can't
  // roll it. Editable specialization (Skills tab only) is a "Spec" toggle plus a
  // text field; a specialized skill splits its rating into −1 / +1, and only
  // trained skills can carry one. Read-only views just show the note.
  const chips = [];
  if (s.trained_only && !bareName) {
    const unusable = !(s.final > 0 || s.dice_bonus);
    chips.push(el("span", { class: "skill-to-chip" + (unusable ? " unusable" : ""),
      title: unusable
        ? "Trained only — unusable: needs at least 1 die in this skill or its group"
        : "Trained only — cannot be used without dice in the skill or its group" },
      "Trained"));
  }
  let nameCell, specText = null;
  if (editable && s.final > 0) {
    chips.push(el("label", { class: "sh-spec-chip" + (specOn ? " on" : ""), title: "Specialize this skill (−1 / +1)" },
      el("input", { type: "checkbox", ...(specOn ? { checked: 1 } : {}),
        onchange: e => {
          const entry = CHAR.skill_specializations[name] ??= { on: false, text: "" };
          entry.on = e.target.checked;
          playChanged();
        } }),
      el("span", {}, "Spec")));
    if (specOn)
      specText = el("input", { type: "text", class: "sh-spec-input",
        value: (spec && spec.text) || "", placeholder: "Specialization…",
        oninput: e => { (CHAR.skill_specializations[name] ??= { on: true, text: "" }).text = e.target.value; schedulePlaySave(); } });
  } else if (specOn && spec.text) {
    specText = el("span", { class: "sub skill-spec-note" }, ` — ${spec.text}`);
  }
  // A specialty that matches no weapon this skill rolls contributes nothing --
  // better than silently costing -1 on everything -- but say so, or a typo just
  // looks like the feature not working.
  const dead = specOn
    ? RULES.classifySpecTerms(spec, name, DATA.tables).dead : [];
  const deadNote = dead.length
    ? el("div", { class: "sub skill-spec-dead" },
        `⚠ no ${name} weapon matches ${dead.map(t => `"${t}"`).join(", ")}`
        + " — not applied")
    : null;
  nameCell = chips.length
    ? el("div", { class: "sh-spec-line" }, el("span", { class: "sh-skillname" }, name), ...chips)
    : name;

  return el("tr", dim ? { class: "dim" } : {},
    el("td", {}, nameCell, specText, deadNote,
      (s.notes && s.notes.length) ? el("div", { class: "sub" }, "✦ " + s.notes.join(" · ")) : null),
    el("td", { class: "num sub" }, s.points ? String(s.points) : ""),
    el("td", { class: "num sub" }, s.bonus ? (s.bonus > 0 ? `+${s.bonus}` : String(s.bonus)) : ""),
    el("td", { class: "num sub" }, groupDice ? String(groupDice) : ""),
    // The rating is the dice limit for a test, so it's the thing to click. A
    // specialized skill shows two ratings and each loads its own: −1 off the
    // specialty, +1 on it. Bonus dice (+Nd) ride along into the count.
    el("td", { class: "num" },
      specOn
        ? el("span", {},
            rollable(el("b", {}, String(s.final - 1)),
              { dice: s.final - 1, bonus: s.dice_bonus || 0, pool: s.pool,
                label: `${name} (outside ${(spec && spec.text) || "specialty"})`,
                note: `${s.final - 1} skill${s.dice_bonus ? ` + ${s.dice_bonus} bonus` : ""}` }),
            el("b", {}, " / "),
            rollable(el("b", {}, String(s.final + 1)),
              { dice: s.final + 1, bonus: s.dice_bonus || 0, pool: s.pool,
                label: `${name}${(spec && spec.text) ? ` (${spec.text})` : ""}`,
                note: `${s.final + 1} skill${s.dice_bonus ? ` + ${s.dice_bonus} bonus` : ""}` }))
        : rollable(el("b", {}, rating),
            { dice: s.final, bonus: s.dice_bonus || 0, label: name, pool: s.pool,
              note: `${s.final} skill${s.dice_bonus ? ` + ${s.dice_bonus} bonus` : ""}` }),
      s.soft ? el("span", { class: "sub" }, ` (soft)`) : null,
      s.dice_bonus ? el("span", { class: "skill-dice" }, `+${s.dice_bonus}d`) : null));
}

function poolSkillList(pool) {
  const names = Object.entries(DATA.skills)
    .filter(([, meta]) => meta.pool === pool)
    .map(([name]) => name)
    .sort((a, b) => (CALC.skills[b].final - CALC.skills[a].final) || a.localeCompare(b));
  const box = el("div", { class: `sh-poolskills ${pool.toLowerCase()}` },
    el("h4", {}, `${pool} skills`));
  const t = el("table", { class: "sh-skilltable" });
  t.append(skillTableHeader());
  for (const name of names) {
    const s = CALC.skills[name];
    t.append(skillTableRow(name, !(s.final > 0 || s.dice_bonus)));
  }
  box.append(t);
  return box;
}

/* ------------------------------------------------ skills tab (display only) */
function shSkills(body) {
  // Martial Arts are Brawn skills, one per style, so their rank and the "learn a
  // style" control sit in the Brawn card with everything else Brawn; the unlocked
  // level effects follow in their own card below the grid. A style never takes a
  // specialization, so these rows carry no Spec toggle.
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const maList = CALC.martial_arts || [];
  const unarmedRank = (CALC.skills["Unarmed Combat"] || { points: 0 }).points;
  const allMaStyles = [...new Set(DATA.tables.martial_arts.map(r => r.Style))].sort();
  const usedMaStyles = new Set(maList.map(m => m.style));

  const appendMartialArtRows = t => {
    t.append(el("tr", { class: "skill-group-row" },
      el("td", { colspan: "5" }, "Martial Arts", " ", trainedOnlyChip(),
        el("span", { class: "sub" }, "  — ≤ Unarmed Combat"))));
    maList.forEach(ma => {
      const atCap = ma.rank >= SKILL_KISMET_CAP || ma.rank >= unarmedRank;
      const cost = skillRaiseCost(ma.rank);
      const raise = ro ? null : el("button", { class: "btn small sh-ma-raise",
        disabled: (atCap || CHAR.play.kismet < cost) ? "1" : null,
        title: ma.rank >= unarmedRank ? "Cannot exceed Unarmed Combat rank"
          : ma.rank >= SKILL_KISMET_CAP ? "Rank 6 is the Kismet cap"
          : `Raise with Kismet (${cost})`,
        onclick: async () => {
          if (!spendKismet(`Raised Martial Arts (${ma.style}) to rank ${ma.rank + 1}`, cost,
              { kind: "martial_art", name: ma.style })) return;
          const adv = CHAR.play.martial_art_advances = CHAR.play.martial_art_advances || {};
          adv[ma.style] = (adv[ma.style] || 0) + 1;
          await playChangedRecalc();
        } }, atCap ? "cap" : `+1 (${cost})`);
      t.append(el("tr", {},
        el("td", {}, el("div", { class: "sh-spec-line" }, el("span", {}, ma.style), raise)),
        el("td", { class: "num sub" }, String(ma.rank)),
        el("td", { class: "num sub" }, ""),
        el("td", { class: "num sub" }, ""),
        el("td", { class: "num" }, el("b", {}, String(ma.rank)))));
    });
    const addable = allMaStyles.filter(s => !usedMaStyles.has(s));
    if (!ro && addable.length && unarmedRank >= 1) {
      const addSel = el("select", { class: "btn-select" },
        el("option", { value: "" }, "Add style…"),
        ...addable.map(s => el("option", {}, s)));
      t.append(el("tr", {}, el("td", { colspan: "5" },
        el("div", { class: "add-row" }, addSel,
          el("button", { class: "btn-add",
            disabled: CHAR.play.kismet < NEW_SKILL_KISMET_COST ? "1" : null,
            onclick: async () => {
              const style = addSel.value; if (!style) return;
              if (!spendKismet(`Learned Martial Arts style: ${style}`, NEW_SKILL_KISMET_COST,
                  { kind: "martial_art", name: style })) return;
              const adv = CHAR.play.martial_art_advances = CHAR.play.martial_art_advances || {};
              adv[style] = (adv[style] || 0) + 1;
              await playChangedRecalc();
            } }, `Add (${NEW_SKILL_KISMET_COST})`)))));
    } else if (!ro && unarmedRank < 1) {
      t.append(el("tr", {}, el("td", { colspan: "5", class: "hint" },
        "Train Unarmed Combat before learning a martial art.")));
    }
  };

  // Each pool gets its OWN card, laid out 2×2 (stacks to 1 column on phones),
  // so nothing crams into a single wide card at narrow widths.
  const grid = el("div", { class: "sh-skillgrid" });
  for (const pool of POOL_ORDER) {
    const card = el("div", { class: `card sh-card sh-skillcard ${pool.toLowerCase()}` },
      el("div", { class: "colhead" }, el("span", {}, pool),
        el("b", {}, String(CALC.pools[pool]))));
    const trained = Object.entries(DATA.skills)
      .filter(([n, m]) => m.pool === pool && (CALC.skills[n].final > 0 || CALC.skills[n].dice_bonus
        || (CALC.skills[n].notes && CALC.skills[n].notes.length)))
      .sort((a, b) => CALC.skills[b[0]].final - CALC.skills[a[0]].final);
    // This tab only lists skills you can actually roll, which would hide a
    // Trained Only skill exactly when it matters -- you have no dice, so it's off
    // the table entirely. List those separately instead of dropping them. The
    // `shown` guard keeps a flagged skill that qualified above (via notes) from
    // appearing twice.
    const shown = new Set(trained.map(([n]) => n));
    const locked = Object.keys(DATA.skills)
      .filter(n => DATA.skills[n].pool === pool && CALC.skills[n].trained_only && !shown.has(n))
      .sort();
    // Brawn always renders its table -- the Martial Arts section lives in it, so
    // it has to be reachable even with no trained Brawn skills.
    const isBrawn = pool === "Brawn";
    if (!trained.length && !locked.length && !isBrawn)
      card.append(el("p", { class: "hint" }, "No trained skills."));
    else {
      const t = el("table", { class: "sh-skilltable" });
      t.append(skillTableHeader());
      for (const [name] of trained) t.append(skillTableRow(name, false, true));
      if (!trained.length)
        t.append(el("tr", {}, el("td", { colspan: "5", class: "hint" }, "No trained skills.")));
      if (locked.length) {
        t.append(el("tr", { class: "skill-group-row" },
          el("td", { colspan: "5" }, "Trained only",
            el("span", { class: "sub" }, "  — unavailable without dice"))));
        for (const name of locked) t.append(skillTableRow(name, true, false, true));
      }
      if (isBrawn) appendMartialArtRows(t);
      card.append(t);
    }
    grid.append(card);
  }
  body.append(grid);
  body.append(el("p", { class: "hint", style: "margin:2px 0 10px" },
    "Raise skills and attributes with Kismet on the Kismet tab."));

  const know = el("div", { class: "card sh-card" },
    el("h3", {}, "Knowledge & Etiquette"));
  const etq = Object.entries(CHAR.etiquettes || {}).filter(([, v]) => v > 0);
  if (etq.length) {
    const row = el("div", { class: "sh-tagrow" });
    for (const [name, pts] of etq)
      row.append(el("span", { class: "sh-tag magic" }, `${name} ${pts}`));
    know.append(el("h4", { class: "sh-h4" }, "Etiquettes"), row);
  } else {
    know.append(el("h4", { class: "sh-h4" }, "Etiquettes"),
      el("p", { class: "hint" }, "No etiquettes."));
  }

  // Knowledge points are never forfeited at finalize — any leftover (or
  // freed up by a later Intelligence raise) budget stays spendable here.
  const kBudget = CALC.knowledge || { budget: 0, spent: 0, remaining: 0 };
  know.append(el("h4", { class: "sh-h4" }, "Knowledges"),
    el("p", { class: "hint", style: "margin:0 0 6px" },
      `${kBudget.remaining} / ${kBudget.budget} points left — 2 × Intelligence `
      + "(+1 per Knowledge Skillsoft), free-form, spendable any time."));
  const kt = el("table", { style: "max-width:560px" });
  allKnowledgeSkills().forEach((k, i) => {
    const atCap = (k.points || 0) >= KNOWLEDGE_RANK_CAP;
    const pointsCtl = el("span", { class: "sh-mini" },
      el("button", { class: "mini-btn", title: "Reduce",
        onclick: async () => { k.points = Math.max(0, (k.points || 0) - 1); await playChangedRecalc(); } }, "−"),
      el("b", {}, String(k.points || 0)),
      el("button", { class: "mini-btn", title: atCap ? `Rank ${KNOWLEDGE_RANK_CAP} is the cap`
          : kBudget.remaining < 1 ? "No Knowledge points left" : "Raise",
        disabled: (atCap || kBudget.remaining < 1) ? "1" : null,
        onclick: async () => { k.points = Math.min(KNOWLEDGE_RANK_CAP, (k.points || 0) + 1); await playChangedRecalc(); } }, "+"));
    kt.append(el("tr", {},
      el("td", {}, el("input", { type: "text", value: k.name || "",
        placeholder: "Knowledge area",
        oninput: e => { k.name = e.target.value; playChanged(false); } })),
      el("td", { class: "num" }, pointsCtl),
      el("td", {}, el("button", { class: "row-del", title: "Remove",
        onclick: async () => { kitOf("knowledge_skills").splice(i, 1); await playChangedRecalc(); } }, "✕"))));
  });
  if (!allKnowledgeSkills().length)
    kt.append(el("tr", {}, el("td", { class: "sub", colspan: "3" }, "No knowledge skills yet.")));
  know.append(kt, el("div", { class: "add-row" },
    el("button", {
      class: "btn-add", disabled: kBudget.remaining < 1 ? "1" : null,
      onclick: async () => { kitOf("knowledge_skills").push({ name: "", points: 1 }); await playChangedRecalc(); },
    }, "Add knowledge skill")));
  body.append(know);

  // Style effects only — rank and "add style" live in the Brawn card above.
  if (maList.length) {
    const maCard = el("div", { class: "card sh-card" },
      el("h3", {}, "Martial Art Style Effects"));
    maList.forEach(ma => {
      maCard.append(el("div", { class: "sh-h4", style: "margin:8px 0 2px" }, ma.style,
        el("span", { class: "sub" }, ` · rank ${ma.rank}`)));
      if (ma.levels.length) {
        ma.levels.forEach(l => maCard.append(statLine(`Level ${l.Level}`, l.Effect)));
        if (ma.mods.applied.length)
          maCard.append(statLine("Applied to stats", ma.mods.applied.join(" · ")));
      } else {
        maCard.append(el("p", { class: "hint" },
          "Raise this style's rank to unlock its level effects."));
      }
    });
    body.append(maCard);
  }
}

/* ------------------------------------------------ kismet tab */
/* KISMET.docx: raising an attribute costs 3 per point up to 10, 4 for 11–15,
 * and 5 for 16+ — cost keyed to the level being bought. */
const attrRaiseCost = newLevel => newLevel <= 10 ? 3 : newLevel <= 15 ? 4 : 5;
const skillRaiseCost = rank => Math.max(1, rank);   // "current skill level in Kismet"

function shKismet(body) {
  const play = CHAR.play;
  const econ = kismetEcon();

  // --- balance + awards
  const balance = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Kismet"),
      el("span", {},
        el("span", { class: "chip magic" }, `Available ${play.kismet}`), " ",
        el("span", { class: "chip" }, `Lifetime ${play.kismet_earned}`))),
    el("p", { class: "hint" },
      "The Agonarch grants Kismet at the end of each session (usually 4–6). "
      + "Every 10 lifetime Kismet grants a boon pick; every second one is a major boon."));
  const awardRow = el("div", { class: "sh-tagrow" });
  for (const [label, n] of KISMET_AWARDS) {
    awardRow.append(el("button", { class: "btn small", onclick: () => {
      awardKismet(label, n); playChanged();
    } }, `${label} +${n}`));
  }
  const customAmt = el("input", { type: "number", value: "1", min: "1", style: "width:70px" });
  awardRow.append(el("span", { class: "sh-inline-adjust" },
    customAmt,
    el("button", { class: "btn small good", onclick: () => {
      const n = parseInt(customAmt.value, 10);
      if (n > 0) { awardKismet("Custom award", n); playChanged(); }
    } }, "Award"),
    el("button", { class: "btn small warn", onclick: () => {
      const n = parseInt(customAmt.value, 10);
      if (n > 0 && spendKismet("Custom spend", n, { kind: "custom" })) playChanged();
    } }, "Spend")));
  balance.append(el("h4", { class: "sh-h4" }, "Session Awards"), awardRow);
  body.append(balance);

  // --- spending: attributes + skills + magic
  const spend = el("div", { class: "card sh-card" },
    el("h3", {}, "Spend Kismet"),
    el("p", { class: "hint" },
      "Attribute +1: 3 Kismet up to level 10, 4 for 11–15, 5 for 16+. "
      + "Skill +1: current level in Kismet (max 6 — mastery boon reaches 7). New skill: 4 Kismet."));
  const two = el("div", { class: "sh-two" });

  const attrBox = el("div", {}, el("h4", { class: "sh-h4" }, "Raise Attributes"));
  for (const [full] of ATTR_ABBR) {
    const a = CALC.attributes[full];
    const cost = attrRaiseCost(a.final + 1);
    const capped = a.final >= a.max;
    attrBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, full),
        el("span", { class: "sub" }, ` ${a.final} / max ${a.max}`)),
      el("button", {
        class: "btn small", disabled: (capped || play.kismet < cost) ? "1" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ${full} to ${a.final + 1}`, cost, { kind: "attribute", name: full })) return;
          play.attribute_advances[full] = (play.attribute_advances[full] || 0) + 1;
          await playChangedRecalc();
        },
      }, capped ? "max" : `+1 (${cost})`)));
  }

  const skillBox = el("div", {}, el("h4", { class: "sh-h4" }, "Raise Existing Skills"));
  const ranked = Object.keys(DATA.skills)
    .filter(n => CALC.skills[n].points > 0)
    .sort((a, b) => CALC.skills[b].points - CALC.skills[a].points);
  if (!ranked.length) skillBox.append(el("p", { class: "hint" }, "No trained skills yet."));
  for (const name of ranked) {
    const s = CALC.skills[name];
    // Martial arts aren't normal skills — they're raised from their own card on
    // the Skills tab (per style), so they never appear in this list.
    const atCap = s.points >= SKILL_KISMET_CAP;
    const cost = skillRaiseCost(s.points);
    skillBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name),
        el("span", { class: "sub" }, ` ${s.pool} · rank ${s.points}`)),
      el("button", {
        class: "btn small", disabled: (atCap || play.kismet < cost) ? "1" : null,
        title: atCap ? "Rank 6 is the Kismet cap — use a mastery boon for 7" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ${name} to rank ${s.points + 1}`, cost, { kind: "skill", name })) return;
          play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
          await playChangedRecalc();
        },
      }, atCap ? "cap 6" : `+1 (${cost})`)));
  }
  const untrained = Object.keys(DATA.skills)
    .filter(n => CALC.skills[n].points === 0).sort();
  const learnSel = el("select", {},
    el("option", { value: "" }, "Learn new skill…"),
    ...untrained.map(n => el("option", {}, n)));
  skillBox.append(el("div", { class: "add-row" }, learnSel,
    el("button", {
      class: "btn-add", disabled: play.kismet < NEW_SKILL_KISMET_COST ? "1" : null,
      onclick: async () => {
        const name = learnSel.value;
        if (!name) return;
        if (!spendKismet(`Learned new skill: ${name}`, NEW_SKILL_KISMET_COST, { kind: "skill", name })) return;
        play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
        await playChangedRecalc();
      },
    }, `Learn (${NEW_SKILL_KISMET_COST})`)));

  two.append(attrBox, skillBox);
  spend.append(two);

  const ritualBox = el("div", {}, el("h4", { class: "sh-h4" }, "Raise Rituals"));
  const ritualNames = DATA.tables.rituals.map(r => r.Name);
  const rankedRituals = ritualNames.filter(n => (CALC.ritual_skills[n] || 0) > 0)
    .sort((a, b) => (CALC.ritual_skills[b] || 0) - (CALC.ritual_skills[a] || 0));
  if (!rankedRituals.length) ritualBox.append(el("p", { class: "hint" }, "No trained rituals yet."));
  for (const name of rankedRituals) {
    const points = CALC.ritual_skills[name] || 0;
    const atCap = points >= SKILL_KISMET_CAP;
    const cost = skillRaiseCost(points);
    ritualBox.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name), el("span", { class: "sub" }, ` rank ${points}`)),
      el("button", {
        class: "btn small", disabled: (atCap || play.kismet < cost) ? "1" : null,
        title: atCap ? "Rank 6 is the Kismet cap — use a mastery boon for 7" : null,
        onclick: async () => {
          if (!spendKismet(`Raised ritual ${name} to rank ${points + 1}`, cost, { kind: "ritual", name })) return;
          play.ritual_advances[name] = (play.ritual_advances[name] || 0) + 1;
          await playChangedRecalc();
        },
      }, atCap ? "cap 6" : `+1 (${cost})`)));
  }
  const untrainedRituals = ritualNames.filter(n => (CALC.ritual_skills[n] || 0) === 0).sort();
  const learnRitualSel = el("select", {},
    el("option", { value: "" }, "Learn new ritual…"),
    ...untrainedRituals.map(n => el("option", {}, n)));
  ritualBox.append(el("div", { class: "add-row" }, learnRitualSel,
    el("button", {
      class: "btn-add", disabled: play.kismet < NEW_SKILL_KISMET_COST ? "1" : null,
      onclick: async () => {
        const name = learnRitualSel.value;
        if (!name) return;
        if (!spendKismet(`Learned new ritual: ${name}`, NEW_SKILL_KISMET_COST, { kind: "ritual", name })) return;
        play.ritual_advances[name] = (play.ritual_advances[name] || 0) + 1;
        await playChangedRecalc();
      },
    }, `Learn (${NEW_SKILL_KISMET_COST})`)));
  spend.append(ritualBox);

  // ZP advancement: unlocks higher-Force casting (drain Stun instead of
  // lethal when Force <= ZP) and widens Amp/augment headroom.
  // Cost rate is an assumption: same tiers as attributes (3 / 4 / 5).
  const zp = CALC.zoetics.zp;
  const zpCost = attrRaiseCost(zp + 1);
  spend.append(el("h4", { class: "sh-h4" }, "Advance Zoetic Potential"),
    el("p", { class: "hint" },
      "ZP gates spell Force: casting a spell with Force above your ZP deals its drain as LETHAL damage; "
      + "at or below ZP, drain is Stun. Cost per point assumed to match attribute tiers."),
    el("div", { class: "sh-advrow", style: "max-width:420px" },
      el("span", {}, el("b", {}, "Zoetic Potential"),
        el("span", { class: "sub" }, ` current ${zp}`)),
      el("button", {
        class: "btn small", disabled: play.kismet < zpCost ? "1" : null,
        onclick: async () => {
          if (!spendKismet(`Raised Zoetic Potential to ${zp + 1}`, zpCost, { kind: "zp" })) return;
          play.zp_advances = (play.zp_advances || 0) + 1;
          await playChangedRecalc();
        },
      }, `+1 (${zpCost})`)));
  body.append(spend);

  // --- boons
  const boons = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Boons"),
      el("span", {},
        el("span", { class: "chip" }, `Regular available ${econ.regularsAvail}`), " ",
        el("span", { class: "chip magic" }, `Major available ${econ.majorsAvail}`))),
    el("p", { class: "hint" },
      `Milestones reached: ${econ.increases} (every 10 lifetime Kismet). `
      + "Regular boons: financial windfall · a new free asset from an old friend · skill mastery (6→7). "
      + "Every second milestone is a major boon — ask the Agonarch."));

  const masterable = Object.keys(DATA.skills).filter(n => CALC.skills[n].points === 6);
  const masterSel = el("select", {},
    el("option", { value: "" }, "Skill at rank 6…"),
    ...masterable.map(n => el("option", {}, n)));
  boons.append(el("div", { class: "sh-tagrow" },
    counterBtn("Redeem: Windfall (roll below)", () => {
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: "Boon redeemed: financial windfall (Agonarch rolls)", delta: 0 });
      playChanged();
    }, econ.regularsAvail ? "accent" : ""),
    counterBtn("Redeem: Free asset", () => {
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: "Boon redeemed: new free random asset (old friend)", delta: 0 });
      playChanged();
    }, econ.regularsAvail ? "accent" : ""),
    counterBtn("Redeem: Major boon", () => {
      if (econ.majorsAvail < 1) { alert("No major boons available."); return; }
      play.major_boons_spent++;
      play.kismet_log.unshift({ label: "MAJOR boon redeemed (see Agonarch)", delta: 0 });
      playChanged();
    }, econ.majorsAvail ? "accent" : "")));
  boons.append(el("div", { class: "add-row" }, masterSel,
    el("button", { class: "btn-add", onclick: async () => {
      const name = masterSel.value;
      if (!name) return;
      if (econ.regularsAvail < 1) { alert("No regular boons available."); return; }
      play.boons_spent++;
      play.kismet_log.unshift({ label: `Boon redeemed: skill mastery — ${name} 6→7`, delta: 0 });
      play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
      await playChangedRecalc();
    } }, "Mastery 6→7 (boon)")));

  // --- specific MAJOR boon options
  play.pool_kismet = play.pool_kismet || {};
  boons.append(el("h4", { class: "sh-h4" }, "Major Boons"));
  const spendMajor = label => {
    if (econ.majorsAvail < 1) { alert("No major boons available."); return false; }
    play.major_boons_spent++;
    play.kismet_log.unshift({ label: `MAJOR boon: ${label}`, delta: 0 });
    return true;
  };
  // 1) magic item / experimental tech
  boons.append(el("div", { class: "sh-tagrow" },
    counterBtn("Gain magic item / experimental tech", () => {
      if (spendMajor("gained a magic item / experimental tech (see Agonarch)")) playChanged();
    }, econ.majorsAvail ? "accent" : "")));
  // 2) raise a rank-7 skill to 8
  const skill7 = Object.keys(DATA.skills).filter(n => CALC.skills[n].points === 7);
  const skill7Sel = el("select", {}, el("option", { value: "" }, "Skill at rank 7…"),
    ...skill7.map(n => el("option", {}, n)));
  boons.append(el("div", { class: "add-row" }, skill7Sel,
    el("button", { class: "btn-add", disabled: skill7.length ? null : "1", onclick: async () => {
      const name = skill7Sel.value;
      if (!name) return;
      if (!spendMajor(`raised ${name} 7→8`)) return;
      play.skill_advances[name] = (play.skill_advances[name] || 0) + 1;
      await playChangedRecalc();
    } }, "Skill 7→8 (major)")));
  // 3) add a permanent Kismet die to a pool
  const poolSel = el("select", {}, el("option", { value: "" }, "Pool…"),
    ...POOL_ORDER.map(p => el("option", {}, p)));
  boons.append(el("div", { class: "add-row" }, poolSel,
    el("button", { class: "btn-add", onclick: async () => {
      const pool = poolSel.value;
      if (!pool) return;
      if (!spendMajor(`+1 Kismet die to ${pool} pool`)) return;
      play.pool_kismet[pool] = (play.pool_kismet[pool] || 0) + 1;
      await playChangedRecalc();
    } }, "+1 Kismet die to pool (major)")));

  const wf = el("ol", { class: "sh-windfall" });
  const wfRows = WINDFALL_TABLE.map(w => { const li = el("li", {}, w); wf.append(li); return li; });
  const wfResult = el("div", { class: "sh-callout", hidden: true });
  boons.append(el("div", { class: "sh-card-head" },
    el("h4", { class: "sh-h4", style: "margin:0" }, "Financial Windfall Table (d6)"),
    counterBtn("🎲 Roll windfall", () => {
      const roll = rollDie(6);
      const rolled = rollDiceInText(WINDFALL_TABLE[roll - 1]);
      wfRows.forEach((li, i) => li.classList.toggle("wf-hit", i === roll - 1));
      wfResult.hidden = false;
      wfResult.replaceChildren(el("b", {}, `Rolled ${roll}: `), rolled);
      play.kismet_log.unshift({ label: `Windfall (d6=${roll}): ${rolled}`, delta: 0 });
      playChanged(false);
    }, "good")),
    wf, wfResult);
  body.append(boons);

  // --- ledger
  const ledger = el("div", { class: "card sh-card" }, el("h3", {}, "Ledger"));
  if (!play.kismet_log.length)
    ledger.append(el("p", { class: "hint" }, "No Kismet activity yet."));
  else {
    const t = el("table", { style: "max-width:640px" });
    t.append(el("tr", {}, el("th", {}, "Entry"), el("th", { class: "num" }, "Kismet"), el("th", {}, "")));
    play.kismet_log.slice(0, 40).forEach(entry =>
      t.append(el("tr", {},
        el("td", {}, entry.label),
        el("td", { class: "num", style: entry.delta > 0 ? "color:var(--ok)" : entry.delta < 0 ? "color:var(--bad)" : "" },
          entry.delta > 0 ? `+${entry.delta}` : String(entry.delta)),
        el("td", {}, entry.delta < 0 && entry.undo
          ? el("button", { class: "btn small", title: "Refund the Kismet and reverse this spend",
              onclick: async () => { undoKismetSpend(entry); await playChangedRecalc(); } }, "Undo")
          : null))));
    ledger.append(t);
  }
  body.append(ledger);
}

/* Fixed 3x1 mod-slot strip for a weapon (Overbarrel / Underbarrel / Chassis),
 * replacing the old side-stacked mod chip list. Each box shows the currently
 * fitted mod's name above its chip (or "—" when empty), with an inline picker
 * to fit a new mod once a box is empty. Dual-slot mods (e.g. Laser Sight, fits
 * either barrel slot) land in whichever of their candidate slots is free. */
function weaponModSlots(entry, mult, weaponName, weaponRow) {
  const table = DATA.tables.weapon_mods;
  const order = ["Overbarrel", "Underbarrel", "Chassis"];
  // A percentage-priced mod (Bling) costs a share of this gun, so every price
  // below — fitting, selling, the dropdown label — is quoted per weapon.
  const base = RULES.weaponBaseCost(weaponRow || {}, entry.ref);
  const priceOf = m => Math.round(RULES.weaponModCost(m, base) * mult);
  const sub = sublistOf(entry, "mods");
  const boxes = RULES.assignWeaponModSlots(sub.items, table).assigned;
  const grid = el("div", { class: "sh-modslots" });
  for (const slot of order) {
    const modName = boxes[slot];
    const modRow = modName ? table.find(m => m.Modification === modName && m.Slot === slot) : null;
    const cls = modSlotClass(slot);
    const box = el("div", { class: `sh-modslot ${cls}` },
      el("div", { class: "sh-modslot-label" }, slot),
      el("div", { class: "sh-modslot-active" }, modName || "—"));
    if (modName) {
      box.append(el("span", {
        class: `chip ${cls}`, style: "cursor:pointer",
        title: "Click to sell or remove",
        onclick: () => {
          const idx = sub.items.findIndex(m => sublistName(m) === modName);
          if (idx < 0) return;
          disposeOfMod({ entry, list: "mods", index: idx, name: modName,
            hostName: weaponName, value: priceOf(modRow) });
        },
      }, modName + " ✕"));
      if (modRow && modRow.Effect)
        box.append(el("div", { class: "sh-modslot-eff" }, modRow.Effect));
    } else {
      const options = table.filter(m => m.Slot === slot);
      box.append(el("select", {
        onchange: e => {
          const name = e.target.value;
          if (!name) return;
          const mr = table.find(m => m.Modification === name && m.Slot === slot);
          const cost = priceOf(mr);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) {
            e.target.value = ""; return;
          }
          sub.add(name);
          logCash(`Fitted ${name} to ${weaponName}`, -cost,
            { kind: "weapon_mod", host: weaponName, name });
          playChangedRecalc();
        },
      }, el("option", { value: "" }, `+ ${slot}…`),
        ...options.map(m => el("option", { value: m.Modification },
          `${m.Modification} (${fmt(priceOf(m))})`))));
    }
    grid.append(box);
  }
  return grid;
}

/* Split an upgrade cost string into the Woolong part and any special-currency
 * remainder: "1500 + 50 Tc" -> {cash:1500, special:"50 Tc"}; "250" -> {cash:250}.
 * Some rows use "and" as the separator ("10000 and 200 Tc"). */
function parseUpgradeCost(str) {
  const m = /^\s*([\d,]+)\s*(?:(?:\+|and)\s*(.+))?$/i.exec(str || "");
  if (!m) return { cash: 0, special: (str || "").trim() };
  return { cash: parseInt(m[1].replace(/,/g, ""), 10) || 0, special: (m[2] || "").trim() };
}

/* Fixed Upgrade 1 / Upgrade 2 boxes for a weapon. Each weapon has at most one
 * of each, defined on its data row (Upgr1_Cost/Upgr1_Eff/Upgr2_Cost/Upgr2_Eff).
 * Unpurchased: the box shows the cost with a Buy button. Purchased: it shows
 * the upgrade's effect. Mixed costs ("1500 + 50 Tc") deduct the Woolong part
 * from cash; the special part pops a reminder to settle with the Agonarch. */
function weaponUpgradeSlots(w, r, mult) {
  const boxes = [];
  for (const n of [1, 2]) {
    const costStr = r[`Upgr${n}_Cost`] || "";
    const eff = r[`Upgr${n}_Eff`] || "";
    if (!costStr && !eff) continue;
    const key = `upgr${n}`;
    const label = `Upgrade ${n}`;
    const box = el("div", { class: "sh-modslot mod-upgrade" },
      el("div", { class: "sh-modslot-label" }, label));
    if (w[key]) {
      box.append(
        el("div", { class: "sh-modslot-active" },
          el("span", { class: "chip mod-upgrade", style: "cursor:pointer",
            title: "Installed — click to remove (not refunded)",
            onclick: async () => {
              if (!confirm(`Remove ${label} (${eff}) from ${w.name}? Not refunded.`)) return;
              delete w[key];
              await playChangedRecalc();
            } }, "Installed ✕")),
        el("div", { class: "sh-modslot-eff" }, eff));
    } else {
      const { cash, special } = parseUpgradeCost(costStr);
      const cost = Math.round(cash * mult);
      box.append(
        el("div", { class: "sh-modslot-active" }, fmt(cost) + (special ? ` + ${special}` : "")),
        el("div", { class: "sh-modslot-eff" }, eff),
        el("button", { class: "btn small", style: "margin-top:4px",
          onclick: async () => {
            if (!confirm(`Install ${label} on ${w.name}?\n\n${eff}\nCost: ${fmt(cost)}${special ? ` + ${special}` : ""}`))
              return;
            if (CHAR.play.cash < cost
                && !confirm(`${label} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
              return;
            w[key] = true;
            logCash(`Installed ${label} (${eff}) on ${w.name}`, -cost);
            if (special)
              alert(`${label} on ${w.name} has an extra cost of ${special} on top of the Woolongs.\n\nMake sure that cost is paid — consult with the Agonarch.`);
            await playChangedRecalc();
          } }, "Buy"));
    }
    boxes.push(box);
  }
  return boxes;
}

/* ------------------------------------------------ gear tab */
/* Which Gear-list categories are expanded, keyed by Class. Module-level like
 * browserOpenState: toggling one re-renders the sheet, so it can't live in the
 * DOM, and it isn't part of the character. Missing = open, so a kit reads
 * exactly as it always did until you collapse something. */
const gearCatOpen = {};

/* Uses tracker for consumables bought per use (Ammo). Adjusts the owned count
   in place and moves NO cash — spending a use isn't a sale, and buying more
   goes through the Buy section, which charges per use. Floors at 0 so a spent
   stack can sit at zero rather than being forced to 1 like other gear. */
/* How much of a placed spirit's effect actually moved a number: all of it, none
   of it, or some. Shared by the Overview infusion card and the Magic tab so the
   two can't disagree. */
function infusionAppliedLabel(spirit) {
  const mods = CALC.infusion_mods || { applied: [], unapplied: [] };
  const applied = (mods.applied || []).some(a => a.source === spirit);
  const pending = (mods.unapplied || []).some(a => a.source === spirit);
  if (applied && pending) return "partly in stats";
  return applied ? "in stats" : "situational";
}

/* Carried-count spinner for a gear row: 0 .. owned. carriedQty / setCarriedQty
 * live in app.js (loaded first) so chargen and the play sheet share one
 * definition of what "carried" means. */
function shCarriedStepper(entry, onChange) {
  const val = el("span", { class: "sv" }, String(carriedQty(entry)));
  const set = async n => {
    val.textContent = String(setCarriedQty(entry, n));
    await onChange();
  };
  const btn = (delta, label, title) => el("button", { class: "btn small", title,
    onclick: () => set(carriedQty(entry) + delta) }, label);
  return el("span", { class: "stepper", title: `Carrying out of ${ownedQty(entry)} owned` },
    btn(-1, "–", "Carry one fewer — the rest stays in your stash"),
    val,
    btn(1, "+", "Carry one more"));
}

/* A bow's Minimum Strength, shown on its row in play. Re-rating a bow in play
 * is really re-buying it, so this is a read-out rather than a stepper: it says
 * what the bow needs and goes red when the character can no longer draw it,
 * which is exactly the case that appears mid-campaign when Strength drops.
 * Returns null for anything that isn't a bow. */
function shMinStrControl(entry, row) {
  const bow = RULES.bowRating(row, entry);
  if (!bow) return null;
  const strength = CALC.attributes.Strength.final;
  const short = strength < bow.minStr;
  return el("span", { class: "sub", style: "margin-left:8px" + (short ? ";color:var(--bad)" : ""),
    title: short ? `Needs Strength ${bow.minStr} to draw — this character has ${strength}`
                 : `Rated to Strength ${bow.minStr}` },
    `Min STR ${bow.minStr}${short ? " ⚠" : ""}`);
}

/* Taking the hotseat means jacking in, and that takes a VCR. Owning one is the
 * test: equippedSelect makes the first rig owned the active one by default, so
 * "owns a rig" and "has one equipped" are the same state in practice. */
function hasVcrRig() { return allRigs().length > 0; }

/* "Hotseat": the unit the player is currently piloting. One at a time — you
 * can't be in two cockpits — so ticking one clears the rest. Its stat block is
 * what the Overview puts above the character's own weapons. */
function shHotseatToggle(key, u) {
  const rg = rigFlags();
  const on = !!rg.hotseat[key];
  const rigged = hasVcrRig();
  return el("label", { class: "sub" + (rigged ? "" : " sh-disabled"),
      style: "display:inline-flex;align-items:center;gap:6px;margin-top:4px",
      title: rigged
        ? `Piloting ${u.label || u.name} — its stats move to the Overview`
        : "No VCR owned — nothing to jack into. Buy a rig on this tab first." },
    el("input", { type: "checkbox", ...(on ? { checked: 1 } : {}),
      ...(rigged ? {} : { disabled: "1" }),
      onchange: e => {
        const want = e.target.checked;
        for (const k of Object.keys(rg.hotseat)) rg.hotseat[k] = false;
        rg.hotseat[key] = want;
        playChanged();
        renderSheet();
      } }),
    el("span", {}, "Hotseat"));
}

/* Plain Carried yes/no for a deck, drone or vehicle — the same flag misc gear
 * uses, minus the quantity. Only carried gear contributes Zoetic Rating. */
function shCarriedToggle(entry) {
  return el("label", { class: "sub",
      style: "display:inline-flex;align-items:center;gap:6px;margin-top:4px",
      title: "Only carried gear contributes Zoetic Rating" },
    el("input", { type: "checkbox", ...(entry.carried !== false ? { checked: 1 } : {}),
      onchange: async e => { entry.carried = e.target.checked; await playChangedRecalc(); } }),
    el("span", {}, "Carried"));
}

/* How many of this you own. Ammo counts in uses, everything else in items, but
 * the control is the same: things get used up at the table — doses taken, rounds
 * fired, grenades thrown — and that has to be recordable without deleting the
 * row and losing the rest of the stack. No cash moves either way: spending isn't
 * selling, and the + is for stock you already have (buying goes through the Buy
 * section, which charges). A stack floors at 0 rather than 1, so an empty one
 * sits there as a reminder to restock; the ✕ is what removes it for good. */
function shUsesStepper(entry, onChange, unit = "use") {
  const val = el("span", { class: "sv" }, String(ownedQty(entry)));
  const btn = (delta, label, title) => el("button", { class: "btn small", title,
    onclick: async () => {
      const before = ownedQty(entry);
      entry.qty = Math.max(0, before + delta);
      const moved = entry.qty - before;          // 0 when already empty
      // Carrying more than you own is nonsense; carriedQty already clamps on
      // read, and this keeps the stored number honest too.
      if (entry.carried_qty != null && entry.carried_qty > entry.qty)
        setCarriedQty(entry, entry.qty);
      val.textContent = String(entry.qty);
      logItemUse(entry.name, moved, entry.qty);
      await onChange();
    } }, label);
  return el("span", { class: "stepper" },
    btn(-1, "–", `Spend one ${unit} (no refund)`),
    val,
    btn(1, "+", `Add one ${unit} you already own — buy more in the Buy section below`));
}

/* Mounted-augment editor for host gear (Power Armor, Arwin Goggles, homebrew
   with a "Mount Types" column). Mounted augments are managed with the gear —
   they never appear on the Augments tab, their ZR is exempt from ZP, and
   their effects only apply while the host is worn / carried / equipped. */
function shMountEditor(entry, hostRow, hostActive) {
  const host = entry.ref;
  const cap = RULES.mountCapability(hostRow || {});
  if (!cap) return null;
  const sub = sublistOf(entry, "mounted");
  const mult = CALC.budget.gear_cost_multiplier || 1;
  const r2 = x => Math.round(x * 100) / 100;
  const copies = Math.max(1, +(host.qty || 1));   // armor entries have no qty
  const capacity = r2(cap.capacity * copies);
  const augRow = name => DATA.tables.augments.find(a => a.Name === name);
  const used = r2(sub.items.reduce((sum, m) => {
    const row = augRow(m.name);
    return sum + (row ? RULES.augmentEffZr(row, m) : 0);
  }, 0));

  const over = used - capacity > 1e-9;
  const free = r2(capacity - used);

  // Same compact layout + modal picker as chargen (helpers shared from
  // app.js); adding here is a purchase, so it charges cash and hits the ledger.
  const wrap = el("div", { class: "sub" });
  wrap.append(el("div", { style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap" },
    el("b", {}, "Mounts"),
    el("span", { style: over ? "color:var(--bad)" : "",
      title: `Mounted augments' ZR never counts against your ZP · accepts ${cap.label}` },
      `${used} / ${capacity} ZP`),
    hostActive ? null : el("span", {}, "· inactive — effects offline"),
    el("button", { class: "btn-add", title: `Accepts ${cap.label} — ${free} ZP free`,
      onclick: () => openMountPicker({
        title: `Mount on ${host.name} — ${free} ZP free`,
        groups: mountBrowserGroups(cap, free, sub.items, mult),
        afterAdd: () => playChangedRecalc(),
        onAdd: name => {
          const row = augRow(name) || {};
          const cost = Math.round((+row.Cost || 0) * mult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
            return;
          sub.add({ name });
          logCash(`Mounted ${name} on ${host.name}`, -cost,
            { kind: "mount", host: host.name, name });
        },
      }) }, "+ Mount")));

  if (sub.items.length) {
    wrap.append(el("div", {}, ...sub.items.map((m, idx) => {
      const row = augRow(m.name) || {};
      const hasZr = +row.ZR > 0;
      // Same α-cyber cash math as the Augments tab: going alpha adds
      // max(base cost, 1000) × the gear multiplier (mirrors rules.js effCost).
      const alphaExtra = Math.round(Math.max(+row.Cost || 0, 1000) * mult);
      return el("span", { class: "chip", style: "margin:2px 4px 0 0" },
        `${m.name} · ${RULES.augmentEffZr(row, m)} `,
        hasZr ? el("button", { class: "chip-btn" + (m.alpha ? " alpha-on" : ""),
          title: (m.alpha ? "α-cyber grade — click to revert" : "Upgrade to α-cyber grade")
            + ` (ZR −20% min 0.1, cost ×2 min +${CURRENCY_SYMBOL}1,000)`,
          onclick: async () => {
            const now = !m.alpha;
            // On a chargen host the mount object IS the creation record, so
            // flipping the flag in place would re-price what creation paid for.
            // Swap it instead: drop the old, fit an α copy, both in play.
            if (sub.onChargenHost && idx < sub.baseCount) {
              sub.removeAt(idx);
              sub.add({ ...m, alpha: now });
            } else {
              m.alpha = now;
            }
            logCash(now ? `Upgraded ${m.name} (${host.name}) to α-cyber grade`
                        : `Reverted ${m.name} (${host.name}) from α-cyber grade`,
              now ? -alphaExtra : alphaExtra);
            await playChangedRecalc();
          } }, "α") : null,
        el("button", { class: "chip-btn", title: "Unmount — sell it on or write it off",
          onclick: () => disposeOfMod({ entry, list: "mounted", index: idx,
            name: m.name, hostName: host.name,
            value: Math.round((+row.Cost || 0) * mult) }) }, "✕"));
    })));
  }
  return wrap;
}

function shGear(body) {
  const play = CHAR.play;
  // Shared read-only flag for the tab's editable controls (a shared view reads
  // the same sheet but must not spend, sell or use anything up).
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  // Weapons & armor carry the small-heritage surcharge; general gear does not.
  const mult = RULES.surchargeFor("weapon", CALC.budget.gear_cost_multiplier || 1);
  const gearMult = RULES.surchargeFor("gear", CALC.budget.gear_cost_multiplier || 1);
  // Armor additionally carries the Extra Arm / Extra Leg +50% surcharge.
  const armorMult = RULES.surchargeFor("armor", CALC.budget.gear_cost_multiplier || 1)
    * (CALC.budget.armor_cost_multiplier || 1);
  const overdrawOK = (name, cost) => CHAR.play.cash >= cost
    || confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`);

  // ===== Jump submenu: scroll to any section within the gear tab.
  const jump = id => () => document.getElementById(id)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
  body.append(el("div", { class: "gear-submenu" },
    ...[["gear-cash", RULES.currencyName()], ["gear-lifestyle", "Lifestyle"], ["gear-weapons", "Weapons"],
        ["gear-armor", "Armor"], ["gear-gear", "Gear"],
        ["gear-vehicles", "Vehicles"], ["gear-buy", "Buy"]]
      .map(([id, label]) => el("button", { onclick: jump(id) }, label))));

  // ===== Woolongs on hand + Lifestyle — half-width, side by side.
  const amt = el("input", { type: "number", value: "100", min: "1", style: "width:90px" });
  const applyCash = sign => {
    const n = parseInt(amt.value, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    logCash(sign > 0 ? "Cash awarded" : "Cash spent", sign * n);
    playChanged();
  };
  const woolongsCard = el("div", { class: "card sh-card", id: "gear-cash" },
    el("h3", {}, `${RULES.currencyName()} on hand`),
    el("div", { class: "sh-cash-row" },
      el("div", { class: "big cash" }, fmt(play.cash)),
      el("span", { class: "sh-inline-adjust" },
        amt,
        el("button", { class: "btn good", onclick: () => applyCash(1) }, "+ Add"),
        el("button", { class: "btn warn", onclick: () => applyCash(-1) }, "− Subtract"))),
    el("p", { class: "hint" },
      "Unspent chargen cash was forfeited at finalize; starting cash was rolled 4d6×100. "
      + "Money gained in play can be spent any time — buy equipment in the Buy section below."));
  const lsCard = lifestyleCard();
  lsCard.id = "gear-lifestyle";

  // Carried load: equipped weapons + worn armor + gear vs Strength. Sits
  // half-width, stacked under Woolongs.
  const wtNum = n => +n || 0;
  let load = 0;
  allWeapons().filter(w => w.equipped !== false).forEach(w => {
    const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
    load += wtNum(r.Weight);
  });
  allArmor().filter(a => a.active !== false).forEach(a => {
    const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
    load += wtNum(r.wt);
  });
  // Only what's actually on you counts against Strength -- gear left in a stash
  // carries no weight, which is the point of the per-item carried count.
  allGear().forEach(g => {
    const r = DATA.tables.misc_gear.find(x => x.Item === g.name) || {};
    load += wtNum(r.Weight) * carriedQty(g);
  });
  load = Math.round(load * 10) / 10;
  const strength = CALC.attributes.Strength.final;
  const overburdened = load > strength;
  const loadCard = el("div", { class: "card sh-card", id: "gear-load" }, el("h3", {}, "Carried load"),
    el("div", { class: "sh-advrow" },
      el("span", {}, "Equipped/worn weight vs Strength"),
      el("b", { style: overburdened ? "color:var(--bad)" : "" }, `${load} / ${strength}`)));
  if (overburdened)
    loadCard.append(el("div", { class: "sh-callout", style: "border-color:var(--bad);color:var(--bad)" },
      el("b", {}, "Overburdened — "),
      `carrying ${load} weight exceeds Strength ${strength}.`));

  body.append(el("div", { class: "sh-two" },
    el("div", {}, woolongsCard, loadCard),
    lsCard));

  // ===== Weapons — owned table (equipped toggle stays live, remove). Buying
  // moved to the Buy section at the bottom.
  const weaponCard = el("div", { class: "card sh-card", id: "gear-weapons" }, el("h3", {}, "Weapons"));
  if (mult > 1) weaponCard.append(el("p", { class: "hint" }, `Heritage surcharge: all costs ×${mult}.`));
  weaponCard.append(el("div", { class: "mod-slot-legend" },
    el("span", { class: "mod-overbarrel" }, "● Overbarrel"),
    el("span", { class: "mod-underbarrel" }, "● Underbarrel"),
    el("span", { class: "mod-chassis" }, "● Chassis"),
    el("span", { class: "mod-upgrade" }, "● Upgrade")));
  if (CALC.combat.optics_notes && CALC.combat.optics_notes.length)
    weaponCard.append(el("p", { class: "hint" }, "Optics: " + CALC.combat.optics_notes.join(" · ")));
  const weaponBuyGroups = Object.entries(
    DATA.tables.weapons.reduce((acc, r) => (((acc[r.Type] ??= []).push(r)), acc), {}))
    .map(([type, rows]) => ({
      label: WEAPON_TYPE_LABELS[type] || type,
      // A bow is priced and rated by the Strength it takes to draw. Buying one
      // in play rates it to this character's Strength — the heaviest they can
      // actually use — and prices it accordingly, so the browser shows what
      // this buyer would pay rather than a base cost the row doesn't have.
      items: rows.map(r => {
        const bow = RULES.bowRating(r, { min_str: CALC.attributes.Strength.final });
        return { name: r.Weapon,
          cost: Math.round((bow ? bow.cost : (+r.Cost || 0)) * mult),
          sub: (r.Type === "Melee" ? `Reach ${r.Reach || 0}` : `Acc ${r.Accuracy || 0}`)
            + ` · DMG ${r.Type === "Melee" ? RULES.meleeDamage(r, CALC.attributes.Strength.final)
                       : bow ? `${bow.damage} (Min STR ${bow.minStr})` : (r.Damage || "—")}`
            + ` · Pen ${r.Pen || 0}` + barrierBit(r, r.Bar)
            + ` · Conceal ${r.Conceal || 0} · ZR ${r.ZR || 0} · wt ${r.Weight || 0}` };
      }),
    }));
  const cyberguns = equippedCyberguns();
  const weaponEntries = ownedWeapons();
  if (weaponEntries.length || cyberguns.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Weapon"), el("th", {}, "Stats"),
      el("th", {}, "Equip"), el("th", {}, "")));
    weaponEntries.forEach(en => {
      const { ref: w, arr, i: wi, inPlay, category } = en;
      const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
      const canMod = !NO_WEAPON_MOD_TYPES.includes(r.Type);
      const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
      t.append(el("tr", {},
        el("td", {},
          // Reordering stays inside the owning array — dragging a play purchase
          // above a chargen one would change which budget paid for it.
          reorderHandle(() => arrayMove(arr, wi, -1), () => arrayMove(arr, wi, 1),
            wi > 0, wi < arr.length - 1),
          el("b", {}, w.name + ((calcRow.smart ?? w.smart) ? " (smart)" : "")),
          (() => {   // the roll hint doubles as the roll button
            // Skill + Accuracy is the limit, so both load; the firing mode's
            // free dice are picked on the Overview, where the mode is chosen.
            const roll = weaponRollParts(r.Type, w.name, calcRow.Accuracy ?? r.Accuracy ?? 0, r.Reach);
            const hint = el("div", { class: "sub", style: "color:var(--manon)" }, roll.text);
            return roll.dice
              ? rollable(hint, { dice: roll.dice, label: w.name, pool: roll.pool,
                  note: `${roll.skill}: ${roll.dice} limit dice — firing-mode bonus `
                    + "dice are added on the Overview" })
              : hint;
          })(),
          shMountEditor(en, r, w.equipped !== false)),
        el("td", { class: "sub" },
          `${r.Type || ""} · Acc ${calcRow.Accuracy ?? r.Accuracy ?? 0} · DMG ${calcRow.Damage ?? r.Damage ?? "—"} · ${r["Firing modes"] || "melee"} · Pen ${r.Pen || 0}${barrierBit(r, calcRow.Bar ?? r.Bar)} · Conceal ${r.Conceal || 0} · ZR ${r.ZR || 0} · Weight ${r.Weight || 0}` +
          ((calcRow.Ammo ?? r.Ammo) ? ` · Ammo ${calcRow.Ammo ?? r.Ammo}` : "")),
        el("td", {},
          el("input", { type: "checkbox", ...(w.equipped !== false ? { checked: 1 } : {}),
            onchange: async e => { w.equipped = e.target.checked; await playChangedRecalc(); } }),
          shMinStrControl(w, r),
          // Thrown weapons stack, and a thrown grenade is gone. Same −/+ the
          // gear rows carry, so the stack can run down without deleting it.
          (!ro && r.Type === "Thrown")
            ? el("div", { class: "sub", style: "margin-top:4px" },
                el("span", { class: "sub" }, "Qty "),
                shUsesStepper(w, playChangedRecalc, "grenade"))
            : null),
        el("td", {}, el("button", { class: "row-del", title: "Sell / remove weapon",
          onclick: () => disposeOfItem({ category, arr, index: wi, inPlay, name: w.name,
            value: Math.round((+r.Cost || 0) * mult) }) }, "✕"))));
      const upgBoxes = weaponUpgradeSlots(w, r, mult);
      if (canMod || upgBoxes.length) {
        const strip = canMod ? weaponModSlots(en, mult, w.name, r)
                             : el("div", { class: "sh-modslots" });
        upgBoxes.forEach(b => strip.append(b));
        t.append(el("tr", { class: "sh-modslots-row" },
          el("td", { colspan: "4" }, strip)));
      }
    });
    cyberguns.forEach(cg => {
      const g = cg.gun;
      t.append(el("tr", {},
        el("td", {}, el("b", {}, cg.name + " (smart)"),
          el("div", { class: "sub" }, "Implanted cyberarm gun — configured on the Augments tab")),
        el("td", { class: "sub" },
          `Cybergun · Acc ${g.Acc} · DMG ${g.Dmg} · ${g.Modes} · Pen ${g.Pen}${barrierBit(g, g.Bar)} · Ammo ${g.Ammo}`),
        el("td", { class: "sub" }, "—"),
        el("td", {}, "")));
    });
    weaponCard.append(t);
  } else {
    weaponCard.append(el("p", { class: "hint" }, "No weapons owned — buy some in the Buy section below."));
  }
  body.append(weaponCard);

  // ===== Armor — owned table (worn toggle stays live, remove). Buying moved
  // to the Buy section at the bottom.
  const armorCard = el("div", { class: "card sh-card", id: "gear-armor" }, el("h3", {}, "Armor"),
    el("p", { class: "hint" },
      `Current totals: ${CALC.combat.ballistic_armor}B / ${CALC.combat.impact_armor}I (augments and powers included). One Outer and one Under piece worn at a time.`));
  const armorItem = r => ({ name: r.Armor, cost: Math.round((+r.Cost || 0) * armorMult),
    sub: `${r.Ballistic}B / ${r.Impact}I · wt ${r.wt}${r.Style === "Y" ? " · styleable" : ""}` });
  const armorBuyGroups = [
    { label: "Outer Armor", items: DATA.tables.armor.filter(r => (r.Slot || "").startsWith("Outer")).map(armorItem) },
    { label: "Under Armor", items: DATA.tables.armor.filter(r => r.Slot === "Under").map(armorItem) },
    { label: "Other", items: DATA.tables.armor.filter(r => !(r.Slot || "").startsWith("Outer") && r.Slot !== "Under").map(armorItem) },
  ];
  const armorEntries = ownedArmor();
  if (armorEntries.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Armor"), el("th", { class: "num" }, "B / I"),
      el("th", {}, "Extras"), el("th", {}, "Worn"), el("th", {}, "")));
    armorEntries.forEach((en, ai) => {
      const { ref: a, arr, i: localIndex, inPlay, category } = en;
      const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
      const baseCost = +r.Cost || 0;
      const extrasSub = sublistOf(en, "extras");
      // Extras are cost multipliers; the marginal charge is base cost × (mult − 1).
      const extrasCell = r.Style === "Y"
        ? fittedCategoryEditor({
            id: `sh-aextras-${ai}-${a.name}`,
            items: extrasSub.items,
            // A piece takes one of each extra, so anything already fitted drops
            // out of the picker — the shortlist is what you can still add. Unfit
            // the chip and it comes back.
            groups: [{ label: "Armor Extras", items: DATA.tables.armor_extras.map(x => ({
              name: x.Extra,
              cost: Math.round(baseCost * ((+x.Multiplier || 1) - 1) * armorMult),
              sub: `×${x.Multiplier}${x.Effects ? " · " + x.Effects : ""}`,
              hidden: extrasSub.items.some(it => sublistName(it) === x.Extra),
            })) }],
            onAdd: name => {
              const ex = DATA.tables.armor_extras.find(x => x.Extra === name) || {};
              const cost = Math.round(baseCost * ((+ex.Multiplier || 1) - 1) * armorMult);
              if (!overdrawOK(name, cost)) return;
              extrasSub.add(name);
              logCash(`Added ${name} to ${a.name}`, -cost,
                { kind: "armor_extra", host: a.name, name });
            },
            onRemove: index => disposeOfMod({ entry: en, list: "extras", index,
              name: sublistName(extrasSub.items[index]), hostName: a.name,
              value: Math.round(baseCost * (((+(DATA.tables.armor_extras
                .find(x => x.Extra === sublistName(extrasSub.items[index])) || {}).Multiplier || 1)) - 1)
                * armorMult) }),
            // No effectOf: every fitted extra already reports its effect on the
            // armor's own line below (CALC.armor effects covers Quality, Style
            // AND Extras), so repeating it beside the chip printed each one
            // twice. The picker still shows the effect where it's needed — when
            // you're choosing what to fit.
            rerender: renderSheet,
            afterAdd: () => playChangedRecalc(),
          })
        : "—";
      // Quality / Style and their gameplay effects (issue #18). CALC.armor is
      // built chargen-then-play, the same order ownedArmor() lists them in, so
      // the combined index goes straight across.
      const arow = (CALC.armor || [])[ai] || {};
      const aeffects = arow.effects || [];
      t.append(el("tr", {},
        el("td", {},
          // A move has to recalc (CALC.armor is index-aligned), and stays inside
          // the owning array so a play purchase can't drift into the chargen run.
          reorderHandle(() => arrayMove(arr, localIndex, -1, playChangedRecalc),
            () => arrayMove(arr, localIndex, 1, playChangedRecalc),
            localIndex > 0, localIndex < arr.length - 1),
          el("b", {}, a.name),
          el("div", { class: "sub" },
            ([arow.material, arow.style].filter(Boolean).join(" · ") || r.Slot || "") + ` · wt ${r.wt || 0}`),
          aeffects.length ? el("div", { class: "sub armor-effects" },
            aeffects.map(e => `${e.label}: ${e.text}`).join(" · ")) : null,
          shMountEditor(en, r, a.active !== false)),
        el("td", { class: "num" }, `${r.Ballistic || 0} / ${r.Impact || 0}`),
        el("td", { class: "sub" }, extrasCell),
        el("td", {}, el("input", { type: "checkbox", ...(a.active !== false ? { checked: 1 } : {}),
          onchange: async e => {
            a.active = e.target.checked;
            // Only one piece per armor slot may be worn at a time.
            if (a.active && r.Slot) {
              ownedArmor().forEach(({ ref: other }) => {
                if (other === a) return;
                const os = (DATA.tables.armor.find(x => x.Armor === other.name) || {}).Slot;
                if (os === r.Slot) other.active = false;
              });
            }
            await playChangedRecalc();
          } })),
        el("td", {}, el("button", { class: "row-del", title: "Sell / remove armor",
          onclick: () => disposeOfItem({ category, arr, index: localIndex, inPlay,
            name: a.name, value: arow.cost ?? Math.round(baseCost * armorMult) }) }, "✕"))));
    });
    armorCard.append(t);
  } else {
    armorCard.append(el("p", { class: "hint" }, "No armor owned — buy some in the Buy section below."));
  }
  body.append(armorCard);

  // ===== Gear list (chargen + bought in play) — remove buttons
  // (Augments moved to their own tab.)
  // Two backing stores rendered as one table (chargen kit, then bought-in-play),
  // under the same Class headings the Buy section groups by, so a long kit can
  // be collapsed down to the category you're looking for. Reordering stays
  // inside an item's own array AND its own heading — moving across either
  // boundary would silently relabel a purchase or its category — so the handles
  // stop at each block's edge.
  // An item whose table row has gone (a deleted homebrew entry) still needs a
  // home, so it falls back to the same "Gear" heading the Buy section uses.
  const gearEntries = ownedGear().map(en => {
    const row = DATA.tables.misc_gear.find(x => x.Item === en.ref.name) || {};
    return { en, row, cls: row.Class || "Gear" };
  });
  const gearCats = [...new Set(gearEntries.map(e => e.cls))].sort((a, b) => a.localeCompare(b));
  const gt = el("table");
  gt.append(el("tr", {}, el("th", {}, "Item"), el("th", { class: "num" }, "Qty"),
    el("th", { class: "num" }, "Weight"),
    el("th", {}, "Effect"), el("th", {}, "Carried"), el("th", {}, "")));
  let gearWeightCarried = 0, gearWeightOwned = 0;
  const round1 = n => Math.round(n * 10) / 10;
  const gearRow = ({ en, row: r }, prev, next) => {
    const { ref: g, inPlay, arr } = en;
    // Focus/Fetish/Spirit Bag links (chosen in chargen) now show — and stay
    // editable — on the sheet (issue #14). gearLinkSelect returns null otherwise.
    const linkSel = (!ro && typeof gearLinkSelect === "function")
      ? gearLinkSelect(g, playChangedRecalc) : null;
    // Ammo counts in uses rather than pieces: its Qty stepper is the rounds you
    // own, and the Carried spinner is how many of those are on you.
    const isAmmo = (r.Class || "").startsWith("Ammo");
    const owned = ownedQty(g);
    const unitWt = wtNum(r.Weight);
    const carried = carriedQty(g);
    return el("tr", {},
      el("td", {},
        reorderHandle(() => prev && arraySwap(arr, en.i, prev.en.i),
          () => next && arraySwap(arr, en.i, next.en.i), !!prev, !!next),
        el("b", {}, g.name),
        inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null,
        linkSel ? el("div", { class: "sub sh-gearlink" }, "Linked to ", linkSel)
          : (g.link ? el("div", { class: "sub" }, `Linked to ${g.link}`) : null),
        shMountEditor(en, r, g.carried !== false)),
      // Everything you own a count of gets the same live −/+ tracker: ammo in
      // rounds (issue #21), and doses, meds and grenades in items, because a
      // stack gets used up at the table and the row shouldn't have to be
      // deleted to say so. It moves no cash — buying more goes through the Buy
      // section below, which charges.
      el("td", { class: "num" }, ro
        ? String(owned)
        : shUsesStepper(g, playChangedRecalc, isAmmo ? "use" : "item")),
      // Unit weight always; the carried subtotal too once it can differ from it.
      el("td", { class: "num sub" }, String(round1(unitWt)),
        (owned > 1 && unitWt > 0)
          ? el("div", { class: "sub" }, `${round1(unitWt * carried)} carried`) : null),
      el("td", { class: "sub" },
        [(+r.Dependence ? `Dependence ${r.Dependence}` : ""), r.Effect || "", r.Notes || ""]
          .filter(Boolean).join(" · ")),
      // More than one owned means "how many are on me" is a real question, so it
      // gets a spinner; a single item is still a plain yes/no.
      el("td", {}, (!ro && owned > 1)
        ? [el("span", { class: "sub" }, "Carried "), shCarriedStepper(g, playChangedRecalc)]
        : [el("span", { class: "sub" }, "Carried "), el("input", { type: "checkbox", ...(g.carried !== false ? { checked: 1 } : {}),
            onchange: async e => {
              setCarriedQty(g, e.target.checked ? owned : 0);
              await playChangedRecalc();
            } })]),
      el("td", {}, el("button", { class: "row-del", title: "Sell / remove item",
        onclick: () => disposeOfItem({ category: "gear", arr, index: en.i, inPlay,
          name: g.name, value: Math.round((+r.Cost || 0) * gearMult * owned) }) }, "✕")));
  };
  // Weights tally over everything owned, collapsed categories included — hiding
  // a heading tidies the list, it doesn't take the load off your back.
  gearEntries.forEach(({ en, row: r }) => {
    const unitWt = wtNum(r.Weight);
    gearWeightCarried += unitWt * carriedQty(en.ref);
    gearWeightOwned += unitWt * ownedQty(en.ref);
  });
  gearCats.forEach(cls => {
    const rows = gearEntries.filter(e => e.cls === cls);
    const open = gearCatOpen[cls] !== false;
    // Per-heading carried weight, so collapsing a category doesn't hide the one
    // number the section is otherwise there to answer.
    const catWt = round1(rows.reduce((sum, { en, row: r }) =>
      sum + wtNum(r.Weight) * carriedQty(en.ref), 0));
    gt.append(el("tr", { class: "sh-gear-cat" },
      el("td", { colspan: "6", role: "button", tabindex: "0",
        title: open ? `Collapse ${cls}` : `Expand ${cls}`,
        onclick: () => { gearCatOpen[cls] = !open; renderSheet(); },
        onkeydown: e => { if (e.key === "Enter" || e.key === " ") e.currentTarget.click(); } },
        el("span", { class: "cat-arrow" }, open ? "▾" : "▸"),
        el("b", {}, cls),
        el("span", { class: "sub" }, ` (${rows.length})`),
        catWt > 0 ? el("span", { class: "sub" }, ` · ${catWt} carried`) : null)));
    if (!open) return;
    // Rows of one category run kit-first then bought-in-play, so a neighbour in
    // the same backing array is simply the adjacent row of this block.
    rows.forEach((e, p) => {
      const sameArr = other => (other && other.en.arr === e.en.arr) ? other : null;
      gt.append(gearRow(e, sameArr(rows[p - 1]), sameArr(rows[p + 1])));
    });
  });
  if (!gearEntries.length)
    gt.append(el("tr", {}, el("td", { class: "sub", colspan: "6" }, "No gear.")));
  else {
    const stashed = round1(gearWeightOwned - gearWeightCarried);
    gt.append(el("tr", { class: "sh-gear-total" },
      el("td", { class: "sub" }, el("b", {}, "Gear weight")),
      el("td", {}, ""),
      el("td", { class: "num" }, el("b", {}, String(round1(gearWeightCarried)))),
      el("td", { class: "sub", colspan: "3" },
        `carried of ${round1(gearWeightOwned)} owned`
        + (stashed > 0 ? ` · ${stashed} left behind` : ""))));
  }
  // One switch for the whole list once there's more than one heading to work.
  const gearCatBar = gearCats.length > 1 ? el("div", { class: "cat-sort" },
    el("span", { class: "sub" }, "Categories"),
    el("button", { class: "cat-sort-btn",
      onclick: () => { gearCats.forEach(c => { gearCatOpen[c] = true; }); renderSheet(); } },
      "Expand all"),
    el("button", { class: "cat-sort-btn",
      onclick: () => { gearCats.forEach(c => { gearCatOpen[c] = false; }); renderSheet(); } },
      "Collapse all")) : null;
  body.append(el("div", { class: "card sh-card", id: "gear-gear" },
    el("h3", {}, "Gear"), gearCatBar, gt));

  // ===== Vehicles / rigs / decks owned (configured on their own tabs).
  // Drones and vehicles get their full Rigging-tab stat + attachment lines here
  // too, so the Gear tab is a complete inventory (issue #20).
  const gearRigs = allRigs(), gearDecks = allDecks();
  const gearDrones = allDrones(), gearVehicles = allVehicles();
  if (gearRigs.length || gearDecks.length || gearDrones.length || gearVehicles.length) {
    const vcard = el("div", { class: "card sh-card", id: "gear-vehicles" },
      el("h3", {}, "Vehicles, Rigs & Decks"),
      el("p", { class: "hint" }, "Bought, modified and removed on the Rigging and Decking tabs."));
    const unitEntries = [
      ...gearDrones.map(u => ({ table: "drones", u })),
      ...gearVehicles.map(u => ({ table: "vehicles", u })),
    ];
    if (unitEntries.length) vcard.append(unitLoadoutTable(unitEntries));
    if (gearRigs.length || gearDecks.length) {
      const vt = el("table");
      vt.append(el("tr", {}, el("th", {}, "Item"), el("th", {}, "Type")));
      // Rigs are gated by which one is active (Rigging tab), not by carrying, so
      // only decks get the toggle.
      const addRows = (list, label, carriable) => list.forEach(u =>
        vt.append(el("tr", {},
          el("td", {}, el("b", {}, u.label || u.name),
            (u.label && u.name) ? el("span", { class: "sub" }, ` (${u.name})`) : null,
            carriable ? shCarriedToggle(u) : null),
          el("td", { class: "sub" }, label))));
      addRows(gearRigs, "VCR", false);
      addRows(gearDecks, "Cyberdeck", true);
      vcard.append(vt);
    }
    body.append(vcard);
  }

  // ===== Buy equipment — all purchasing lives here, collapsible by type.
  // (Augments are bought on the Augments tab.)
  const gearBuyGroups = Object.entries(
    DATA.tables.misc_gear.reduce((acc, r) => (((acc[r.Class || "Gear"] ??= []).push(r)), acc), {}))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, rows]) => ({
      label: cls,
      items: rows.map(r => ({ name: r.Item, cost: Math.round((+r.Cost || 0) * gearMult),
        sub: [(+r.Dependence ? `Dependence ${r.Dependence}` : ""), r.Effect || "", r.Notes || "",
          (r.Class || "").startsWith("Ammo") ? "per use" : ""]
          .filter(Boolean).join(" · ") })),
    }));
  const buySection = el("div", { class: "card sh-card", id: "gear-buy" },
    el("h3", {}, "Buy equipment"),
    el("p", { class: "hint" }, `Everything purchasable from ${RULES.currencyName().toLowerCase()}, grouped by type. `
      + (mult > 1 ? `Heritage surcharge ×${mult} applies to weapons & armor (not general gear). ` : "")
      + "Augments are bought on the Augments tab; decks, programs, rigs, drones and vehicles on the Decking and Rigging tabs."));
  const buyBlock = (title, browser) =>
    buySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, title), browser));
  buyBlock("Weapons", categoryBrowser({ id: "sh-buy-weapons", groups: weaponBuyGroups,
    rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    onAdd: name => {
      const r = DATA.tables.weapons.find(x => x.Weapon === name) || {};
      const bow = RULES.bowRating(r, { min_str: CALC.attributes.Strength.final });
      const cost = Math.round((bow ? bow.cost : (+r.Cost || 0)) * mult);
      if (!overdrawOK(name, cost)) return;
      const entry = { name, smart: Boolean(r["Integrated Smart"]),
        mods: [], equipped: true, qty: 1 };
      if (bow) entry.min_str = bow.minStr;
      CHAR.play.purchases.weapons.push(entry);
      logCash(`Bought ${name}${bow ? ` (Min STR ${bow.minStr})` : ""}`, -cost,
        { kind: "weapon", name });
    } }));
  buyBlock("Armor", categoryBrowser({ id: "sh-buy-armor", groups: armorBuyGroups,
    rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    onAdd: name => {
      const r = DATA.tables.armor.find(x => x.Armor === name) || {};
      const cost = Math.round((+r.Cost || 0) * mult);
      if (!overdrawOK(name, cost)) return;
      CHAR.play.purchases.armor.push({ name, style: "", material: "", extras: [], active: true });
      logCash(`Bought ${name}`, -cost, { kind: "armor", name });
    } }));
  buyBlock("Gear", categoryBrowser({ id: "sh-buy-gear", groups: gearBuyGroups,
    rerender: renderSheet, afterAdd: () => {},
    onAdd: name => buyGear(name, gearMult) }));
  body.append(buySection);

  // ===== Activity (cash ledger) — moved to the bottom
  if (play.cash_log.length) {
    const t = el("table", { style: "max-width:560px" });
    play.cash_log.slice(0, 20).forEach(entry =>
      t.append(el("tr", {},
        el("td", {}, entry.label),
        // A zero-delta row is a record of something that changed without money
        // moving (an unpaid lifestyle adjustment) — show a dash, not "+ㄓ0".
        el("td", { class: "num", style: !entry.delta ? "color:var(--dim)"
                     : entry.delta > 0 ? "color:var(--ok)" : "color:var(--bad)" },
          entry.delta ? (entry.delta > 0 ? "+" : "") + fmt(entry.delta).replace("ㄓ-", "−ㄓ") : "—"),
        // Undo is only offered where there is something to take back: a
        // purchase this ledger knows how to reverse.
        el("td", {}, (entry.undo && CASH_UNDO[entry.undo.kind])
          ? el("button", { class: "btn small",
              title: entry.delta ? `Undo this purchase and refund ${fmt(-entry.delta)}`
                                 : "Undo this change and restore the previous value",
              onclick: () => undoCashSpend(entry) }, "Undo")
          : null))));
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, "Activity"),
      el("p", { class: "hint" },
        "Undo takes back a purchase in full — the item goes and the "
        + `${RULES.currencyName().toLowerCase()} comes back. Removing an item on the `
        + "tabs above only removes it; the money stays spent."),
      t));
  }
}

/* ------------------------------------------------ augments tab */
// Preferred display order for augment type groups; unlisted types follow
// alphabetically.
const AUG_TYPE_ORDER = ["Headware", "Eyeware", "Earware", "Bodyware", "Bioware",
  "Cyberlimbs", "Right Arm", "Left Arm", "Right Leg", "Left Leg", "Mobi"];

function shAugments(body) {
  const play = CHAR.play;
  const mult = CALC.budget.gear_cost_multiplier || 1;
  const z = CALC.zoetics;

  const augEntries = ownedAugments();
  // Slotted Skillsofts grant their bonus; how many can be slotted at once is
  // capped by the number of Chipjacks installed.
  const ownedAugsAll = allAugmentsOwned();
  const chipjackCount = ownedAugsAll
    .filter(a => a.name === "Chipjack").reduce((sum, a) => sum + (a.count || 1), 0);
  const slottedSkillsoftCount = ownedAugsAll
    .filter(a => a.name.startsWith("Skillsoft") && a.slotted !== false).length;

  const augHeaderCard = el("div", { class: "card sh-card" }, el("h3", {}, "Augments"),
    el("div", { class: "sh-advrow" },
      el("span", {}, RULES.houseRule("zr") === "houserule" ? "Cyber ZP Spent" : "Augment ZR"),
      el("b", {}, String(z.augment_zr))),
    ...(z.mounted_zr ? [el("div", { class: "sh-advrow",
        title: "ZR of augments mounted on gear (Gear tab) — never counts against your ZP" },
      el("span", {}, "Mounted on gear (ZP-exempt)"), el("b", {}, String(z.mounted_zr)))] : []),
    ...(z.mount_errors || []).map(msg =>
      el("div", { class: "sh-advrow", style: "color:var(--bad)" }, msg)),
    el("div", { class: "sh-advrow" },
      el("span", {}, `Body Index (max ${CALC.attributes.Body.final})`),
      el("b", { style: z.body_index_ok ? "" : "color:var(--bad)" }, String(z.body_index))),
    el("p", { class: "hint" },
      "α-cyber Augments are bleeding edge, reducing the ZR by 20% but doubling the cost. "
      + "Augments mounted on gear are managed on the Gear tab with their host item."));

  // Curated "special senses & immunities" summary — sits beside the Augments card.
  const sensesCard = (CALC.combat.sense_notes && CALC.combat.sense_notes.length)
    ? el("div", { class: "card sh-card" }, el("h3", {}, "Senses & immunities"),
        ...CALC.combat.sense_notes.map(s =>
          el("p", { class: "hint", style: "margin:4px 0" }, el("b", {}, s.name + ": "), s.effect)))
    : null;
  body.append(sensesCard
    ? el("div", { class: "sh-two" }, augHeaderCard, sensesCard)
    : augHeaderCard);

  // One card per augment type, in anatomical-ish order.
  const byType = {};
  augEntries.forEach(en => {
    const r = DATA.tables.augments.find(x => x.Name === en.ref.name) || {};
    (byType[r.Type || "Other"] ??= []).push(en);
  });
  const types = Object.keys(byType).sort((a, b) => {
    const ia = AUG_TYPE_ORDER.indexOf(a), ib = AUG_TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const augmentRow = ({ ref: a, inPlay, arr, i: augIndex }) => {
    const r = DATA.tables.augments.find(x => x.Name === a.name) || {};
    // Cybertechtronic augments are surcharged; Bioware is grown to fit (face value).
    const augMult = RULES.surchargeFor(r.Type === "Bioware" ? "bioware" : "cyberware", mult);
    const isSkillsoft = a.name.startsWith("Skillsoft");
    const hasZr = !!(+r.ZR);
    const alphaZr = hasZr ? RULES.augmentEffZr(r, { alpha: true }) : 0;
    // Going alpha adds max(base cost, 1000) — mirrors rules.js effCost (min
    // applied to raw cost, then × the gear multiplier) so the play-mode cash
    // ledger stays in step with the recalculated total.
    const alphaExtra = Math.round(Math.max(+r.Cost || 0, 1000) * augMult);
    const alphaCell = hasZr
      ? el("label", { class: "opt", title: `α-cyber grade: ZR ${alphaZr} (−20%, min −0.1), cost ×2 (min +${CURRENCY_SYMBOL}1,000)` },
          el("input", { type: "checkbox", ...(a.alpha ? { checked: 1 } : {}),
            onchange: async e => {
              a.alpha = e.target.checked;
              logCash(a.alpha ? `Upgraded ${a.name} to α-cyber grade`
                              : `Reverted ${a.name} from α-cyber grade`,
                a.alpha ? -alphaExtra : alphaExtra);
              await playChangedRecalc();
            } }),
          el("span", {}, `ZR ${a.alpha ? alphaZr : +r.ZR}`))
      : el("span", { class: "sub" }, "—");
    // Skillsofts target a player-chosen skill (like chargen) and only grant
    // their bonus while slotted, capped by owned Chipjacks.
    let target = null, slottedCell = el("span", { class: "sub" }, "—");
    if (isSkillsoft) {
      target = el("select", { onchange: async e => { a.target = e.target.value; await playChangedRecalc(); } },
        el("option", { value: "" }, "Skill…"),
        ...Object.keys(DATA.skills).sort().map(x => el("option", {}, x)));
      target.value = a.target || "";
      const isSlotted = a.slotted !== false;
      const atCap = !isSlotted && slottedSkillsoftCount >= chipjackCount;
      slottedCell = el("label", {
        class: "opt",
        title: atCap
          ? `Only ${chipjackCount} Chipjack(s) installed — unslot another Skillsoft first`
          : "Apply this Skillsoft's bonus to its target skill",
      },
        el("input", { type: "checkbox", ...(isSlotted ? { checked: 1 } : {}),
          disabled: atCap ? "1" : null,
          onchange: async e => { a.slotted = e.target.checked; await playChangedRecalc(); } }));
    }
    // Knowledge Skillsofts bought in play get a cash-aware +/- stepper —
    // each unit adds a Knowledge skill point. Chargen-installed ones (or
    // other augments) show a static count; the chargen record is immutable
    // in play, so extra copies are bought in play instead.
    const unitCost = Math.round((+r.Cost || 0) * augMult);
    const countCell = (inPlay && a.name === "Knowledge Skillsoft")
      ? el("td", { class: "num" }, el("span", { class: "stepper" },
          el("button", { title: "Remove one (refunded)", onclick: async () => {
            if ((a.count || 1) <= 1) return;
            a.count -= 1;
            logCash("Removed a Knowledge Skillsoft", unitCost);
            await playChangedRecalc();
          } }, "–"),
          el("b", {}, String(a.count || 1)),
          el("button", { title: "Install another", onclick: async () => {
            if (CHAR.play.cash < unitCost
                && !confirm(`Another Knowledge Skillsoft costs ${fmt(unitCost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
              return;
            a.count = (a.count || 1) + 1;
            logCash("Installed Knowledge Skillsoft", -unitCost);
            await playChangedRecalc();
          } }, "+")))
      : el("td", { class: "num" }, String(a.count || 1));
    // Cybergun shows its chosen gun's stats; melee implants show computed damage.
    const gun = a.name === "Cybergun Installation" && a.gunType
      ? (DATA.tables.cyberguns || []).find(g => g.Type === a.gunType) : null;
    const implantDmg = RULES.augmentMeleeDamage(r, CALC.attributes.Strength.final, CALC.martial_art && CALC.martial_art.mods);
    const effectText = gun
      ? [r.Effect || "", `${gun.Type}: Acc ${gun.Acc} · DMG ${gun.Dmg} · Ammo ${gun.Ammo} · ${gun.Modes} · Pen ${gun.Pen} · Rarity ${gun.Rarity}`].filter(Boolean).join(" · ")
      : [r.Effect || "", implantDmg !== "" ? `DMG ${implantDmg}` : ""].filter(Boolean).join(" · ");
    // Cybergun: choose / change the mounted gun in play. The gun-cost difference
    // (× heritage surcharge) is charged or refunded to the play cash ledger.
    let gunSel = null;
    if (a.name === "Cybergun Installation") {
      gunSel = el("select", { onchange: async e => {
        const nv = e.target.value;
        const oldGun = (DATA.tables.cyberguns || []).find(g => g.Type === a.gunType);
        const newGun = (DATA.tables.cyberguns || []).find(g => g.Type === nv);
        const delta = Math.round(((newGun ? +newGun.Cost : 0) - (oldGun ? +oldGun.Cost : 0)) * mult);
        if (delta > 0 && CHAR.play.cash < delta
            && !confirm(`${nv} costs ${fmt(delta)} more but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) {
          e.target.value = a.gunType || ""; return;
        }
        a.gunType = nv;
        if (delta !== 0) logCash(`Cybergun gun: ${oldGun ? oldGun.Type : "none"} → ${nv || "none"}`, -delta);
        await playChangedRecalc();
      } },
        el("option", { value: "" }, "Choose gun…"),
        ...(DATA.tables.cyberguns || []).map(g =>
          el("option", { value: g.Type }, `${g.Type} (${fmt(Math.round(+g.Cost * mult))})`)));
      gunSel.value = a.gunType || "";
    }
    // Fashionware quality tier (issue #19). Switching tier re-prices the piece,
    // so charge/refund the difference through the cash ledger. Costed via
    // augmentEffCost so any α-grade premium is re-derived on the new base.
    let qualitySel = null;
    if (r.Quality === "Y") {
      qualitySel = el("select", { class: "fw-quality-select", onchange: async e => {
        const nv = e.target.value;
        const before = Math.round(RULES.augmentEffCost(r, a) * augMult);
        const after = Math.round(RULES.augmentEffCost(r, { ...a, quality: nv }) * augMult);
        const delta = after - before;
        if (delta > 0 && CHAR.play.cash < delta
            && !confirm(`${nv || "Normal"} costs ${fmt(delta)} more but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) {
          e.target.value = a.quality || ""; return;
        }
        const prev = a.quality || "standard";
        a.quality = nv;
        if (delta !== 0) logCash(`${a.name} quality: ${prev} → ${nv || "standard"}`, -delta);
        await playChangedRecalc();
      } },
        el("option", { value: "" }, "Quality…"),
        ...(DATA.tables.fashionware_qualities || []).map(q =>
          el("option", { value: q.Quality }, `${q.Quality} ×${q.Multiplier}`)));
      qualitySel.value = a.quality || "";
    }
    return el("tr", {},
      el("td", {}, el("b", {}, a.name),
        inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null,
        r.Rarity ? el("div", { class: "sub" }, `Rarity ${r.Rarity}`) : null,
        target, gunSel, qualitySel),
      countCell,
      el("td", {}, alphaCell),
      el("td", {}, slottedCell),
      el("td", { class: "sub" }, effectText,
        descriptionExpander(r.Description, `augments:${a.name}`)),
      // Cyberware comes out surgically: there is no resale market for a used
      // arm, so the dialog opens with nothing offered. A table that wants to
      // allow a chop-shop sale can still type a number in.
      el("td", {}, el("button", { class: "row-del", title: "Remove (surgical removal — not refunded)",
        onclick: () => disposeOfItem({ category: "augments", arr, index: augIndex, inPlay,
          name: a.name, value: 0 }) }, "✕")));
  };
  if (!augEntries.length) {
    body.append(el("div", { class: "card sh-card" },
      el("p", { class: "hint" }, "No augments installed — buy some below.")));
  }
  for (const type of types) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Augment"), el("th", { class: "num" }, "×"),
      el("th", {}, "α-cyber"), el("th", {}, "Slotted"), el("th", {}, "Effect"), el("th", {}, "")));
    byType[type].forEach(en => t.append(augmentRow(en)));
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, type), t));
  }

  // ===== Buy augments — same browser that used to live on the Gear tab.
  const augAvail = augmentAvailability(ownedAugsAll);
  const syntheticNoBio = CHAR.heritage.type === "Synthetic";
  // Cyberlimb augments may need a cyberarm/leg first (data "Req Limb").
  const ARM_T = new Set(["Right Arm", "Left Arm"]), LEG_T = new Set(["Right Leg", "Left Leg"]);
  const buyAugType = a => (DATA.tables.augments.find(x => x.Name === a.name) || {}).Type || "";
  const ownsArm = ownedAugsAll.some(a => ARM_T.has(buyAugType(a)));
  const ownsLeg = ownedAugsAll.some(a => LEG_T.has(buyAugType(a)));
  // Cyberguns are capped at one per cyberarm.
  const cyberarmCount = ownedAugsAll.filter(a => ARM_T.has(buyAugType(a))).length;
  const cybergunCount = ownedAugsAll.filter(a => a.name === "Cybergun Installation").length;
  const buyLimbNeed = r => {
    switch (RULES.augmentLimbRequirement(r)) {
      case "Arm": return ownsArm ? null : "a Cyberarm";
      case "Leg": return ownsLeg ? null : "a Cyberleg";
      case "Any": return (ownsArm || ownsLeg) ? null : "a Cyberarm or Cyberleg";
      default:    return null;
    }
  };
  const augBuyGroups = Object.entries(
    DATA.tables.augments.reduce((acc, r) => (((acc[r.Type || "Augment"] ??= []).push(r)), acc), {}))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, rows]) => ({
      label: type,
      items: rows.map(r => {
        const bioBanned = syntheticNoBio && r.Type === "Bioware";
        const banned = bioBanned ? "Synthetics cannot install Bioware" : augAvail.bannedReason(r.Name);
        const need = buyLimbNeed(r);
        const dmg = RULES.augmentMeleeDamage(r, CALC.attributes.Strength.final, CALC.martial_art && CALC.martial_art.mods);
        const isCybergun = r.Name === "Cybergun Installation";
        let disabled = !!need;
        let reason = banned || (need ? `Requires ${need} installed` : "");
        let note = banned ? "banned" : (need ? `needs ${need}` : "");
        if (isCybergun && !banned && !need && cybergunCount >= cyberarmCount) {
          disabled = true;
          reason = `One cybergun per cyberarm (${cybergunCount}/${cyberarmCount} installed)`;
          note = "at capacity";
        }
        return {
          name: r.Name,
          // augmentEffCost, not the raw row: it carries the Classic-ZR
          // cyberlimb doubling, so the quote matches what the engine prices.
          cost: Math.round(RULES.augmentEffCost(r, {})
            * RULES.surchargeFor(r.Type === "Bioware" ? "bioware" : "cyberware", mult)),
          sub: `ZR ${r.ZR || 0} · BI ${r.BI || 0}${dmg !== "" ? " · DMG " + dmg : ""}`
            + (r.Rarity ? ` · Rarity ${r.Rarity}` : "")
            + (r.Quality === "Y" ? " · quality tiers available" : "")
            + (r.Effect ? " · " + r.Effect : ""),
          banned: !!banned,
          disabled,
          reason,
          note,
        };
      }),
    }));
  body.append(el("div", { class: "card sh-card" },
    el("h3", {}, "Buy augments"),
    el("p", { class: "hint" },
      (mult > 1 ? `Heritage surcharge ×${mult} applies to cybertechtronic augments (Bioware pays face value). ` : "")
      + "Installed augments appear above, grouped by type."),
    el("div", { class: "sh-unit-add" },
      categoryBrowser({ id: "sh-buy-augments", groups: augBuyGroups,
        rerender: renderSheet, afterAdd: () => {},
        onAdd: name => buyAugment(name, mult) }))));
}

/* prepaid lifestyle months: tick up/down, buy months, one active at a time */
function lifestyleCard() {
  const play = CHAR.play;
  const card = el("div", { class: "card sh-card" },
    el("h3", {}, "Lifestyle"),
    el("p", { class: "hint" },
      "Each sector turn requires eliminating one month of pre-purchased lifestyle "
      + "or paying upkeep for your desired lifestyle."));
  // Hyperthyroid raises lifestyle cost 10% (matches HYPERTHYROID_LIFESTYLE_SURCHARGE in rules.js).
  const hasHyperthyroid = allAugmentsOwned()
    .some(a => a.name === "Hyperthyroid");
  const lifestyleSurcharge = hasHyperthyroid ? 1.10 : 1;
  play.lifestyles.forEach((ls, i) => {
    const row = DATA.tables.lifestyles.find(x => x.Lifestyle === ls.name) || {};
    const monthly = Math.round((+row.MonthlyCost || 0) * lifestyleSurcharge);
    card.append(el("div", { class: "sh-advrow" + (ls.active ? " active-row" : "") },
      el("span", {},
        el("input", { type: "radio", name: "ls-active", title: "Set as current lifestyle",
          ...(ls.active ? { checked: 1 } : {}),
          onchange: () => {
            play.lifestyles.forEach(l => { l.active = false; });
            ls.active = true; playChanged();
          } }),
        " ", el("b", {}, ls.name),
        el("span", { class: "sub" }, ` ${fmt(monthly)}/month`)),
      el("span", { class: "sh-unit-ctr" },
        // Free to tick — burning a month per sector turn costs nothing, and a
        // GM correction shouldn't have to route through a purchase. But it
        // moves prepaid months that WERE paid for, so every change lands in the
        // ledger at zero cash: visible, undoable, and impossible to confuse
        // with the "+1 mo" button beside it, which charges.
        miniCounter("Months", () => ls.months || 0, v => {
          const from = ls.months || 0;
          if (v === from) return;
          ls.months = v;
          logCash(`Adjusted ${ls.name} lifestyle to ${v} mo (unpaid)`, 0,
            { kind: "lifestyle_adjust", name: ls.name, from });
        }),
        counterBtn(`+1 mo (${fmt(monthly)})`, () => {
          if (play.cash < monthly
              && !confirm(`A month of ${ls.name} costs ${fmt(monthly)} but you have ${fmt(play.cash)}. Overdraw?`))
            return;
          ls.months = (ls.months || 0) + 1;
          if (monthly) logCash(`Prepaid 1 month of ${ls.name} lifestyle`, -monthly,
            { kind: "lifestyle_month", name: ls.name });
          playChanged();
        }, "accent"),
        el("button", { class: "row-del", title: "Remove lifestyle",
          onclick: () => {
            if (!confirm(`Remove ${ls.name}? Remaining prepaid months are lost.`)) return;
            play.lifestyles.splice(i, 1); playChanged();
          } }, "✕"))));
  });
  const activeLs = play.lifestyles.find(l => l.active);
  if (activeLs)
    card.append(el("div", { class: "sh-callout lifestyle" },
      el("b", {}, `${activeLs.name} — current effect: `),
      LIFESTYLE_EFFECTS[activeLs.name] || "No listed effect."));
  else
    card.append(el("p", { class: "hint" }, "No current lifestyle selected — pick one with the radio button."));
  const addable = DATA.tables.lifestyles.filter(r => !play.lifestyles.some(l => l.name === r.Lifestyle));
  if (addable.length) {
    const addSel = el("select", {}, el("option", { value: "" }, "Add lifestyle…"),
      ...addable.map(r => el("option", { value: r.Lifestyle }, `${r.Lifestyle} — ${fmt(r.MonthlyCost)}/month`)));
    card.append(el("div", { class: "add-row" }, addSel,
      el("button", { class: "btn-add", onclick: () => {
        if (!addSel.value) return;
        play.lifestyles.push({ name: addSel.value, months: 0, active: !play.lifestyles.length });
        playChanged();
      } }, "Add")));
  }
  return card;
}

async function buyGear(name, mult) {
  if (!name) return;
  const r = DATA.tables.misc_gear.find(x => x.Item === name);
  if (!r) return;
  const cost = Math.round(r.Cost * mult);
  if (CHAR.play.cash < cost
      && !confirm(`${name} costs ${fmt(cost)} but you only have ${fmt(CHAR.play.cash)}. Overdraw?`))
    return;
  const existing = CHAR.play.purchases.gear.find(g => g.name === name);
  if (existing) existing.qty = (existing.qty || 1) + 1;
  else CHAR.play.purchases.gear.push({ name, qty: 1 });
  logCash(`Bought ${name}`, -cost, { kind: "gear", name });
  await playChangedRecalc();
}
async function buyAugment(name, mult) {
  if (!name) return;
  const r = DATA.tables.augments.find(x => x.Name === name);
  if (!r) return;
  // Synthetics can't install Bioware; block augments that conflict with
  // something already installed.
  if (CHAR.heritage.type === "Synthetic" && r.Type === "Bioware") {
    alert(`Can't install ${name}: Synthetics cannot install Bioware.`); return;
  }
  const owned = allAugmentsOwned();
  const banReason = augmentAvailability(owned).bannedReason(name);
  if (banReason) { alert(`Can't install ${name}: ${banReason}.`); return; }
  // Cyberguns are capped at one per installed cyberarm.
  if (name === "Cybergun Installation") {
    const armTypes = new Set(["Right Arm", "Left Arm"]);
    const arms = owned.filter(a => armTypes.has((DATA.tables.augments.find(x => x.Name === a.name) || {}).Type)).length;
    const guns = owned.filter(a => a.name === "Cybergun Installation").length;
    if (arms === 0) { alert("Can't install a Cybergun: requires a Cyberarm."); return; }
    if (guns >= arms) { alert(`Can't install another Cybergun: one per cyberarm (${guns}/${arms}).`); return; }
  }
  // Bioware is grown to fit and never carries the small-heritage surcharge.
  // Priced through augmentEffCost so a Classic-ZR cyberlimb is charged at the
  // doubled rate the chargen budget uses -- reading r.Cost straight made
  // limbs half price when bought in play.
  const cost = Math.round(RULES.augmentEffCost(r, {})
    * RULES.surchargeFor(r.Type === "Bioware" ? "bioware" : "cyberware", mult));
  const z = CALC.zoetics;
  const newBI = z.body_index + (+r.BI || 0);
  const newZR = z.cyber_zr + z.amp_zr + (+r.ZR || 0);
  if (newBI > CALC.attributes.Body.final
      && !confirm(`Warning: Body Index would reach ${newBI} (Body ${CALC.attributes.Body.final}) — Too Many Biomods. Install anyway?`))
    return;
  if (newZR > z.zp
      && !confirm(`Warning: total Zoetic Rating would reach ${newZR} (ZP ${z.zp}). Install anyway?`))
    return;
  if (CHAR.play.cash < cost
      && !confirm(`${name} costs ${fmt(cost)} but you only have ${fmt(CHAR.play.cash)}. Overdraw?`))
    return;
  // Stackable augments (Knowledge Skillsoft, Chipjack, Memory) grow one entry's
  // count so repeated buys read as "× N" rather than a wall of duplicate rows.
  const existing = isStackableAugment(name)
    && CHAR.play.purchases.augments.find(a => a.name === name && !a.alpha);
  if (existing) existing.count = (existing.count || 1) + 1;
  else CHAR.play.purchases.augments.push({ name, count: 1 });
  logCash(`Installed ${name}`, -cost, { kind: "augment", name });
  await playChangedRecalc();
}

// Augments whose quantity is meaningful and merged into a single entry.
function isStackableAugment(name) {
  return name === "Chipjack" || name === "Memory-1 EB" || name === "Knowledge Skillsoft";
}

/* The bound half of a spirit's writeup, for one bond tile: its services, its
 * statblock and its appearance, each behind its own expander so four bound
 * spirits still fit in the card. `force` resolves the [F] terms in the text.
 * Returns an array of nodes (possibly empty) to append to the tile. */
function bondSpiritDetail(name, row, force) {
  const out = [];
  const services = parseSpiritServices(row["Bound Services"]);
  for (const svc of services) {
    out.push(expanderPanel(`bond:${name}:${svc.name || svc.text.slice(0, 24)}`,
      svc.name || "Service", ...withForce(svc.text, force)));
  }
  if (!services.length) {
    out.push(el("p", { class: "hint" }, "No bound-services writeup for this spirit yet."));
  }

  // Ballistic/Impact are armor values, so they're labelled the way the rest of
  // the app labels armor. Omit any stat this spirit doesn't list.
  const stats = [["Move", row.Movement], ["Init", row.Initiative],
    ["Condition", row.Condition], ["B Armor", row.Ballistic],
    ["I Armor", row.Impact], ["Def Dice", row["Defense Dice"]]]
    .filter(([, v]) => String(v || "").trim());
  const attacks = splitSpiritEntries(row.Attacks);
  const special = splitSpiritEntries(row.Special);
  if (stats.length || attacks.length || special.length) {
    const kids = [];
    if (stats.length) {
      kids.push(el("div", { class: "sh-spirit-stats" },
        ...stats.map(([k, v]) => el("div", {},
          el("div", { class: "k" }, k),
          el("div", { class: "v" }, ...withForce(v, force))))));
    }
    for (const a of attacks) {
      kids.push(el("div", { class: "sh-spirit-line" }, ...withForce(a, force)));
    }
    for (const sp of special) {
      kids.push(el("div", { class: "sh-spirit-line sub" }, ...withForce(sp, force)));
    }
    // A few spirits list the statblock of the cohort they summon rather than
    // their own; "Statblock Of" names it so the label says whose it is. Spirits
    // with no stats at all (Miasma, Stormwing) carry only their special rules.
    const of = String(row["Statblock Of"] || "").trim();
    const label = !stats.length && !attacks.length ? "Special"
      : of ? `Statblock — ${of}` : "Statblock";
    out.push(expanderPanel(`bond:${name}:stats`, label, ...kids));
  }

  const look = descriptionExpander(row.Appearance, `bond:${name}:look`, "Appearance");
  if (look) out.push(look);
  return out;
}

/* ------------------------------------------------ magic tab */
function shMagic(body) {
  const type = CALC.magic.type;
  const play = CHAR.play;

  // House rule: gear/weapon ZR is a spellcasting dice penalty (−1d per full
  // point), not a ZP cost. Surface the current penalty at the top of the tab.
  if (RULES.houseRule("zr") === "houserule" && type !== "Hedge") {
    const gearZr = CALC.zoetics.gear_zr || 0;
    const pen = Math.floor(gearZr);
    body.append(pen > 0
      ? el("div", { class: "sh-callout warn" },
          el("b", {}, `ZR Casting Penalty: −${pen}d `),
          `on all spellcasting rolls (Channeling, Conjuring, Sorcery). `
          + `${gearZr} ${gearZr === 1 ? "point" : "points"} of gear/weapon ZR — −1d per full point.`)
      : el("div", { class: "sh-callout info" },
          el("b", {}, "ZR Casting Penalty: none. "),
          `Each full point of gear/weapon ZR is −1d on spellcasting rolls `
          + `(Channeling, Conjuring, Sorcery). Currently ${gearZr} ZR.`));
  }

  const zp = CALC.zoetics.zp;
  const allSpells = [
    ...CHAR.magic.spells.map(s => ({ ...s, inPlay: false })),
    ...play.purchases.spells.map(s => ({ ...s, inPlay: true }))];
  if (allSpells.length || type === "Mage" || type === "Archmage") {
    const wrap = el("div", { class: "card sh-card" },
      el("div", { class: "sh-card-head" },
        el("h3", {}, "Spells"),
        el("span", { class: "chip magic" }, `ZP ${zp}`)));
    wrap.append(el("p", { class: "hint" },
      `Spells cost their listed price in ${RULES.currencyName().toLowerCase()} per Force to learn or advance. `
      + `Casting at Force above your ZP (${zp}) deals drain as LETHAL damage; at or below, drain is Stun.`));
    for (const sp of allSpells) {
      const r = DATA.tables.spells.find(x => x.Name === sp.name) || {};
      const force = sp.force + (play.spell_force_advances[sp.name] || 0);
      const lethal = force > zp;
      const perForce = Math.round(+r.Cost || 0);
      wrap.append(el("div", { class: "sh-spell" },
        el("div", {}, el("b", {}, sp.name), " ",
          el("span", { class: "chip magic" }, `F${force}`), " ",
          el("span", { class: "chip" + (lethal ? " neg" : " ok") },
            lethal ? "drain: LETHAL" : "drain: stun"),
          el("span", { class: "sub" }, ` ${r.School || ""}`),
          sp.inPlay ? el("span", { class: "sh-tag" }, "learned in play") : null,
          " ",
          el("button", { class: "btn small",
            disabled: force >= SPELL_FORCE_MAX ? "1" : null,
            title: force >= SPELL_FORCE_MAX ? `Maximum Force is ${SPELL_FORCE_MAX}`
              : `Advance Force (${fmt(perForce)} per Force)`,
            onclick: async () => {
              if (force >= SPELL_FORCE_MAX) return;
              if (play.cash < perForce
                  && !confirm(`+1 Force costs ${fmt(perForce)} but you have ${fmt(play.cash)}. Overdraw?`))
                return;
              play.spell_force_advances[sp.name] = (play.spell_force_advances[sp.name] || 0) + 1;
              logCash(`${sp.name}: Force ${force} → ${force + 1}`, -perForce);
              await playChangedRecalc();
            } }, force >= SPELL_FORCE_MAX ? `Force ${SPELL_FORCE_MAX} (max)` : `+1 Force (${fmt(perForce)})`)),
        el("div", { class: "sub" },
          `Drain: ${r.Drain || "—"} · Resist: ${r["Target Resistance"] || "—"} · Duration: ${r.Duration || "—"}`),
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null,
        descriptionExpander(r.Description, `spells:${sp.name}`)));
    }
    // learn a new spell with cash: listed Cost × starting Force
    if (type === "Mage" || type === "Archmage") {
      const known = new Set(allSpells.map(s => s.name));
      const learnable = DATA.tables.spells.filter(r =>
        !known.has(r.Name) && (type === "Archmage" || !CHAR.magic.school || r.School === CHAR.magic.school));
      if (learnable.length) {
        const shortEff = s => (s && s.length > 90) ? s.slice(0, 89) + "…" : (s || "");
        const spellSel = el("select", {},
          el("option", { value: "" }, "Learn new spell…"),
          ...learnable.map(r => el("option", { value: r.Name, title: r.Effect || "" },
            `${r.Name} (${r.School}) — ${fmt(Math.round(+r.Cost || 0))}/Force`
            + (r.Effect ? ` — ${shortEff(r.Effect)}` : ""))));
        const forceSel = el("select", {},
          ...[1, 2, 3, 4, 5, 6].map(f => el("option", { value: String(f) }, `Force ${f}`)));
        wrap.append(el("div", { class: "add-row" }, spellSel, forceSel,
          el("button", { class: "btn-add", onclick: async () => {
            const name = spellSel.value, force = parseInt(forceSel.value, 10);
            if (!name) return;
            const r = DATA.tables.spells.find(x => x.Name === name);
            const cost = Math.round((+r.Cost || 0) * force);
            if (play.cash < cost
                && !confirm(`${name} at Force ${force} costs ${fmt(cost)} but you have ${fmt(play.cash)}. Overdraw?`))
              return;
            play.purchases.spells.push({ name, force });
            logCash(`Learned ${name} at Force ${force}`, -cost, { kind: "spell", name });
            await playChangedRecalc();
          } }, "Buy")));
      }
    }
    body.append(wrap);
  }

  // amp powers (chargen + bought) + buy control — `ref` keeps the original
  // entry so target picks on play purchases actually persist
  const allPowers = [
    ...CHAR.magic.amp_powers.map(p => ({ ...p, ref: p, inPlay: false })),
    ...play.purchases.amp_powers.map(p => ({ ...p, ref: p, inPlay: true }))];
  if (allPowers.length || type === "Amp" || type === "Archmage") {
    const zo = CALC.zoetics;
    const wrap = el("div", { class: "card sh-card" },
      el("div", { class: "sh-card-head" },
        el("h3", {}, "Amp Powers"),
        el("span", {},
          el("span", { class: "chip magic" }, `Amp ZP spent ${zo.amp_zp_spent}`), " ",
          el("span", { class: "chip" + (zo.zp_remaining < 0 ? " neg" : "") },
            `ZP remaining ${zo.zp_remaining}`))));
    if (zo.amp_offline)
      wrap.append(el("div", { class: "sh-callout" },
        "⚠ AMP POWERS OFFLINE — ZP is negative. Shed carried ZR or the powers stay dark."));
    for (const p of allPowers) {
      const r = DATA.tables.amp_powers.find(x => x.Name === p.name) || {};
      // Targeted powers bought in play still need their target picked here —
      // without it, Attribute Boost/Increase and Expertise grant nothing.
      const needsAttr = ["Attribute Boost", "Attribute Increase"].includes(p.name);
      const needsSkill = p.name === "Expertise";
      let targetCtl = null;
      if (p.inPlay && (needsAttr || needsSkill)) {
        targetCtl = el("select", { onchange: async e => {
          p.ref.target = e.target.value; await playChangedRecalc();
        } },
          el("option", { value: "" }, "Choose target…"),
          ...(needsAttr ? ATTR_ABBR.map(([full]) => full)
                        : Object.keys(DATA.skills).sort()).map(x => el("option", {}, x)));
        targetCtl.value = p.target || "";
      }
      // Amps pay half the listed ZP — show both numbers so the listed cost
      // isn't mistaken for what was actually deducted.
      const listedZp = +r["ZP Cost"] || 0;
      const paidZp = listedZp * (type === "Amp" ? 0.5 : 1);
      wrap.append(el("div", { class: "sh-spell amp" },
        el("div", {}, el("b", {}, p.name), " ",
          el("span", { class: "chip",
            title: paidZp !== listedZp ? "Amps pay half the listed ZP cost" : null },
            r["ZP Cost"] == null ? "? ZP"
              : paidZp !== listedZp ? `${listedZp} ZP → paid ${paidZp}`
              : `${listedZp} ZP`),
          p.target && !targetCtl ? el("span", { class: "sub" }, ` → ${p.target}`) : null,
          (p.times || 1) > 1 ? el("span", { class: "sub" }, ` ×${p.times}`) : null,
          p.inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null,
          targetCtl ? el("span", {}, " ", targetCtl) : null,
          targetCtl && !p.target
            ? el("span", { class: "sub", style: "color:var(--bad)" }, " ← needs a target to apply")
            : null),
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null,
        descriptionExpander(r.Description, `amp_powers:${p.name}`)));
    }
    if (type === "Amp" || type === "Archmage") {
      const zpMult = type === "Amp" ? 0.5 : 1;
      const powerSel = el("select", {}, el("option", { value: "" }, "Buy amp power…"),
        ...DATA.tables.amp_powers.map(r =>
          el("option", { value: r.Name }, `${r.Name} — ${(+r["ZP Cost"] || 0) * zpMult} ZP`)));
      wrap.append(el("div", { class: "add-row" }, powerSel,
        el("button", { class: "btn-add", onclick: async () => {
          const name = powerSel.value;
          if (!name) return;
          const r = DATA.tables.amp_powers.find(x => x.Name === name);
          const zpCost = (+r["ZP Cost"] || 0) * zpMult;
          if (zpCost > CALC.zoetics.zp_remaining) {   // ZP can never go negative on a purchase
            alert(`${name} needs ${zpCost} ZP but only ${CALC.zoetics.zp_remaining} remains. ZP cannot go negative.`);
            return;
          }
          play.purchases.amp_powers.push({ name, target: "", times: 1 });
          await playChangedRecalc();
        } }, "Buy (ZP)")));
      wrap.append(el("p", { class: "hint" },
        "New powers draw on your remaining ZP and cannot take it below 0"
        + (type === "Amp" ? " (Amps pay half the listed ZP)." : ".")));
    }
    body.append(wrap);
  }

  if (type === "Speaker" || type === "Archmage") {
    const s = CHAR.speaker;
    play.infusion_spirits = play.infusion_spirits || {};
    play.bond_slots = play.bond_slots || [];
    // Infusion slot base name -> the spirit column that holds its benefit.
    const slotColumn = slot => {
      const base = slot.replace(/\s*\d+$/, "").trim();
      return base === "Firearms" ? "Firearm" : base;
    };
    const spiritRow = name => DATA.tables.speaker_spirits.find(x => x.Spirit === name) || {};
    const card = el("div", { class: "card sh-card" },
      el("h3", {}, "Speaker — Spirits, Infusions & Bonds"));

    if (s.relationships.length) {
      const row = el("div", { class: "sh-tagrow" });
      for (const name of s.relationships) {
        const r = spiritRow(name);
        row.append(el("span", { class: "sh-tag magic" },
          `${name}${r.Element ? " · " + r.Element : ""}`));
      }
      card.append(el("h4", { class: "sh-h4" }, "Relationships"), row);
    } else {
      card.append(el("p", { class: "hint" }, "No spirit relationships — add them in chargen."));
    }

    // --- Infusions (#26): place a spirit into each infusion slot; show benefit
    if (s.infusions.length) {
      card.append(el("h4", { class: "sh-h4" }, "Infusions — place a spirit for its benefit"));
      for (const slot of s.infusions) {
        const col = slotColumn(slot);
        const placed = play.infusion_spirits[slot] || "";
        const sel = el("select", { onchange: e => {
          if (e.target.value) play.infusion_spirits[slot] = e.target.value;
          else delete play.infusion_spirits[slot];
          playChanged();
        } }, el("option", { value: "" }, "— empty —"),
          // A spirit can only be invoked once, so one already placed in another
          // slot isn't offered here (the engine dedupes too, as a safety net).
          ...s.relationships
            .filter(n => n === placed
              || !Object.entries(play.infusion_spirits).some(([k, v]) => k !== slot && v === n))
            .map(n => el("option", { value: n }, n)));
        sel.value = placed;
        const benefit = placed ? (spiritRow(placed)[col] || "no listed benefit") : "";
        // Say whether this placement moved a number or has to be played out at
        // the table, so "active" isn't mistaken for "already in my stats".
        card.append(el("div", { class: "sh-advrow" + (placed ? " active-row" : "") },
          el("span", {}, el("b", {}, slot),
            placed ? el("span", { class: "chip ok", style: "margin-left:6px" }, "active") : null,
            placed ? el("span", { class: "sh-tag", style: "margin-left:6px" },
              infusionAppliedLabel(placed)) : null,
            benefit ? el("div", { class: "sub", style: "color:var(--ok)" }, benefit) : null),
          sel));
      }
      if (CALC.infusion_mods && CALC.infusion_mods.applied.length) {
        card.append(el("p", { class: "hint" }, "Folded into your stats: "
          + CALC.infusion_mods.applied.map(a => `${a.text} (${a.source})`).join(" · ")));
      }
      // quick reference: every spirit's benefit for each infusion type
      const ref = el("details", { style: "margin-top:8px" }, el("summary", { class: "sub" }, "All spirit infusion benefits"));
      const rt = el("table", { style: "margin-top:6px" });
      rt.append(el("tr", {}, el("th", {}, "Spirit"), el("th", {}, "Firearm"),
        el("th", {}, "Protection"), el("th", {}, "Drone"), el("th", {}, "Digital"), el("th", {}, "Physical")));
      for (const name of s.relationships) {
        const r = spiritRow(name);
        rt.append(el("tr", {}, el("td", {}, el("b", {}, name)),
          el("td", { class: "sub" }, r.Firearm || "—"), el("td", { class: "sub" }, r.Protection || "—"),
          el("td", { class: "sub" }, r.Drone || "—"), el("td", { class: "sub" }, r.Digital || "—"),
          el("td", { class: "sub" }, r.Physical || "—")));
      }
      ref.append(rt);
      card.append(ref);
    }

    // --- Bonds (#27): place spirits in bond slots and track favors
    const bondCount = RULES.speakerBondCount(CHAR);
    card.append(el("h4", { class: "sh-h4" }, `Bonds — ${bondCount} slot(s), track favors owed`));
    if (!bondCount) card.append(el("p", { class: "hint" }, "No spirit bonds purchased in chargen."));
    // Grow to the bought count, never shrink. Dropping Bonds in chargen and
    // raising it again must hand the spirit back, so slots past the count are
    // kept dormant and simply not rendered — the array is play state, and the
    // count alone decides how much of it is live (see speakerBondCount).
    while (play.bond_slots.length < bondCount) play.bond_slots.push({ spirit: "", force: 0, favors: 0 });
    const dormant = play.bond_slots.slice(bondCount).filter(b => b && b.spirit);
    const bondTiles = el("div", { class: "sh-bond-tiles" });
    play.bond_slots.slice(0, bondCount).forEach((bond, bi) => {
      const sel = el("select", { onchange: e => { bond.spirit = e.target.value; playChanged(); } },
        el("option", { value: "" }, "— empty —"),
        ...s.relationships.map(n => el("option", { value: n }, n)));
      sel.value = bond.spirit || "";
      const row = bond.spirit ? spiritRow(bond.spirit) : {};
      // Each slot keeps one identity colour (see --bond-N in style.css) so four
      // bound spirits stay tellable apart; slots past the fourth wrap around.
      const tile = el("div", { class: `sh-bond-tile slot-${(bi % 4) + 1}`
          + (bond.spirit ? " active" : "") },
        el("div", { class: "k" }, `Bond ${bi + 1}`),
        sel);
      if (row.Element) tile.append(el("div", { class: "sh-bond-meta" },
        el("span", { class: "sh-tag magic" }, row.Element)));
      // Force drives the [F] terms in the ability text below, so it sits with
      // Favors above the detail rather than buried under it.
      tile.append(el("div", { class: "sh-bond-fav" },
        bond.spirit
          ? miniCounter("Force", () => bond.force || 0, v => { bond.force = v; }, 0, 12)
          : null,
        miniCounter("Favors", () => bond.favors || 0, v => { bond.favors = v; }, 0, 99)));
      if (bond.spirit) tile.append(...bondSpiritDetail(bond.spirit, row, bond.force || 0));
      bondTiles.append(tile);
    });
    if (bondCount) card.append(bondTiles);
    // Say so out loud, otherwise a dropped bond looks like lost data.
    if (dormant.length) card.append(el("p", { class: "hint" },
      `Held for ${dormant.length} bond slot(s) you no longer have: `
      + dormant.map(b => b.spirit).join(" · ")
      + ". Raise Bonds in chargen to get them back — nothing has been deleted."));

    if (CHAR.magic.archmage_bind) card.append(statLine("Bound spirit (chargen)", "yes (15 Force)"));
    body.append(card);
  }

  // Rituals — full reference table with the character's current level in each
  // (raised via Kismet on the Kismet tab). Shown for every magic type, since
  // rituals are bought as ordinary skill points at chargen regardless of type.
  {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Ritual"), el("th", { class: "num" }, "Level"),
      el("th", {}, "Drain"), el("th", {}, "Time"), el("th", {}, "Effect")));
    for (const r of DATA.tables.rituals) {
      const lvl = (CALC.ritual_skills || {})[r.Name] || 0;
      t.append(el("tr", { class: lvl > 0 ? "sh-ritual-trained" : null },
        el("td", {}, el("b", {}, r.Name)),
        el("td", { class: "num" }, lvl > 0 ? el("b", {}, String(lvl)) : el("span", { class: "sub" }, "—")),
        el("td", { class: "sub" }, r.Drain),
        el("td", { class: "sub" }, r.Time),
        el("td", { class: "sub" }, r.Effect,
          descriptionExpander(r.Description, `rituals:${r.Name}`))));
    }
    body.append(el("div", { class: "card sh-card" },
      el("h3", {}, "Rituals ", trainedOnlyChip()), t));
  }
}

/* ------------------------------------------------ decking tab */
function shDecking(body) {
  const dk = CHAR.play.decking;
  const deckEntries = ownedDecks();
  const decks = deckEntries.map(e => e.ref);
  if (decks.length && !decks.some(d => d.name === dk.active_deck))
    dk.active_deck = decks[0].name;
  const active = DATA.tables.decks.find(x => x.Name === dk.active_deck);

  // Decks, deck mods, programs and hacking levels are not physical kit — the
  // small-heritage surcharge never applies (surchargeFor("deck") → 1).
  const mult = RULES.surchargeFor("deck", CALC.budget.gear_cost_multiplier || 1);
  // Buy browsers collect here and render at the bottom of the tab.
  const deckBuySection = el("div", { class: "card sh-card", id: "deck-buy" },
    el("h3", {}, "Buy decks & programs"));
  const deckCard = el("div", { class: "card sh-card" }, el("h3", {}, "Cyberdecks"));
  deckEntries.forEach((en, di) => {
    const { ref: d, arr: deckArr, i: deckIndex, inPlay, category } = en;
    const r = DATA.tables.decks.find(x => x.Name === d.name) || {};
    const isActive = d.name === dk.active_deck;
    const modSub = sublistOf(en, "mods");
    const deckModCost = name => Math.round(
      (+(DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {}).Cost || 0) * mult);
    const modEditor = fittedCategoryEditor({
      id: `sh-dmods-${di}-${d.name}`,
      items: modSub.items,
      groups: modGroups(DATA.tables.deck_mods, "Deck Mod", null, "Deck Mods"),
      onAdd: name => {
        const cost = deckModCost(name);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        modSub.add(name);
        logCash(`Fitted ${name} to ${d.name}`, -cost,
          { kind: "deck_mod", host: d.name, name });
      },
      onRemove: index => disposeOfMod({ entry: en, list: "mods", index,
        name: sublistName(modSub.items[index]), hostName: d.name,
        value: deckModCost(sublistName(modSub.items[index])) }),
      effectOf: name => (DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {}).Effect || "",
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    });
    deckCard.append(el("div", { class: "sh-unit" },
      el("div", {},
        el("div", { class: "sh-advrow" + (isActive ? " active-row" : ""), style: "border:0;padding:0" },
          el("span", {}, el("b", {}, d.name),
            el("span", { class: "sub" },
              ` MCP ${r.MCP} · Hardening ${r.Hardening} · Threads ${r.Threads} · Core ${r.Core} · I/O ${r.IO}`)),
          isActive ? el("span", { class: "chip ok" }, "Active")
            : counterBtn("Set Active", () => {
                dk.active_deck = d.name; dk.loaded = []; playChanged();
              })),
        el("div", { class: "sh-unit-add" }, el("b", {}, "Mods"), modEditor)),
      el("button", { class: "row-del", title: "Sell / remove deck",
        onclick: async () => {
          const row = DATA.tables.decks.find(x => x.Name === d.name) || {};
          if (!await disposeOfItem({ category, arr: deckArr, index: deckIndex, inPlay,
            name: d.name, value: Math.round((+row.Cost || 0) * mult) })) return;
          if (dk.active_deck === d.name) { dk.active_deck = ""; dk.loaded = []; }
          await playChangedRecalc();
        } }, "✕")));
  });
  if (!decks.length) deckCard.append(el("p", { class: "hint" }, "No decks owned."));

  // buy a new cyberdeck in play
  const deckGroups = [{ label: "Cyberdecks", items: DATA.tables.decks.map(x => ({
    name: x.Name, cost: Math.round((+x.Cost || 0) * mult),
    sub: `MCP ${x.MCP} · Threads ${x.Threads} · Core ${x.Core} · I/O ${x.IO}` })) }];
  deckBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, "Buy cyberdeck"),
    categoryBrowser({ id: "buy-decks", groups: deckGroups,
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      onAdd: name => {
        const row = DATA.tables.decks.find(x => x.Name === name) || {};
        const cost = Math.round((+row.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        CHAR.play.purchases.decks.push({ name, mods: [] });
        logCash(`Bought ${name}`, -cost, { kind: "deck", name });
      } })));
  body.append(deckCard);

  // --- hacking program: the deck's operating system, slotted per deck. Costs
  // no thread and no I/O; a deck without one doesn't run at all.
  const activeEntry = deckEntries.find(e => e.ref.name === (active && active.Name));
  const required = active ? RULES.deckHackingRequired(active) : 0;
  const slotted = activeEntry ? (activeEntry.ref.hacking || "") : "";
  const ownedHacking = allPrograms().filter(RULES.isHackingProgram);
  const rating = RULES.hackingProgramRating(slotted);
  const meets = !active || (slotted && ownedHacking.includes(slotted) && rating >= required);
  const hackBox = el("div", { class: "sh-hackbox" },
    el("div", { class: "sh-card-head" },
      el("h4", { class: "sh-h4", style: "margin:0" }, "Hacking Program"),
      el("span", { class: "chip" + (meets ? " ok" : " neg") },
        !active ? "no active deck"
          : !slotted ? "none slotted"
          : `${slotted} / required ${required}`)),
    el("p", { class: "hint" },
      "A deck runs on the Hacking program slotted into it — buy one below and pick it "
      + "here. It must be rated at least ½ the deck's MCP (round down, min 1)"
      + (active ? ` — min ${required} for ${active.Name} (MCP ${active.MCP})` : "")
      + ". It uses no thread and no I/O, and moves between decks freely."),
    activeEntry
      ? el("div", { class: "add-row" },
          el("span", { class: "sub" }, "Slotted "),
          (() => {
            const sel = el("select", { onchange: async e => {
              activeEntry.ref.hacking = e.target.value; await playChangedRecalc(); } },
              el("option", { value: "" },
                ownedHacking.length ? "— no Hacking program —" : "— none owned —"),
              ...ownedHacking.map(n => el("option", { value: n },
                `${n}${RULES.hackingProgramRating(n) < required ? " (under ½ MCP)" : ""}`)));
            sel.value = slotted;
            return sel;
          })())
      : el("p", { class: "hint" }, "Set a deck active to slot its Hacking program."));

  const threads = active ? +active.Threads : 0;
  const progCard = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Programs"),
      el("span", { class: "chip" + (dk.loaded.length > threads ? " neg" : "") },
        `Loaded ${dk.loaded.length} / ${threads}`)),
    hackBox);   // the Hacking program lives at the top of the Programs section
  // Programs whose I/O is N/A or No are never loaded onto threads — they run
  // without occupying a thread slot, so no Load button is shown for them. The
  // gear-ZR rule reads the same predicate, so the two can't disagree about what
  // being loaded means.
  const programEntries = ownedPrograms();
  programEntries.forEach(({ ref: name, arr: progArr, i: progIndex, inPlay, category }) => {
    const r = DATA.tables.programs.find(x => x.Name === name) || {};
    const io = r["I/O"] || "—";
    const loadable = RULES.programNeedsThread(r);
    const loaded = dk.loaded.includes(name);
    const nodeCtrl = ` · Node Control ${r["Node Control"] || "N"}`;
    const pSkill = RULES.programSkill(name);   // EW programs: EW skill (Classic) or Hacking
    progCard.append(el("div", { class: "sh-advrow" },
      el("span", {}, el("b", {}, name),
        el("span", { class: "sub" }, ` ${r.Attack || ""} · I/O ${io} · Alert ${r.Alert || 0}${nodeCtrl}`),
        pSkill ? el("div", { class: "sub" }, `Skill: ${pSkill}`) : null,
        r.Effect ? el("div", { class: "sub" }, r.Effect) : null,
        descriptionExpander(r.Description, `programs:${name}`)),
      el("span", { style: "display:flex;gap:6px;align-items:center" },
        loadable
          ? counterBtn(loaded ? "Unload" : "Load", () => {
              if (loaded) dk.loaded = dk.loaded.filter(n => n !== name);
              else if (dk.loaded.length >= threads) { alert("All threads are in use — unload something first."); return; }
              else dk.loaded.push(name);
              playChanged();
            }, loaded ? "" : "accent")
          : el("span", { class: "chip", title: `I/O ${io}: runs without occupying a thread` }, "no load"),
        el("button", { class: "row-del", title: "Sell / remove program",
          onclick: async () => {
            const pr = DATA.tables.programs.find(x => x.Name === name) || {};
            if (!await disposeOfItem({ category, arr: progArr, index: progIndex, inPlay,
              name, value: Math.round((+pr.Cost || 0) * mult) })) return;
            dk.loaded = dk.loaded.filter(n => n !== name);
            await playChangedRecalc();
          } }, "✕"))));
  });
  if (!programEntries.length) progCard.append(el("p", { class: "hint" }, "No programs owned."));

  // buy new programs in play (grouped by Attack class, owned ones drop out)
  const ownedProg = new Set(allPrograms());
  const progByType = {};
  DATA.tables.programs.forEach(pr =>
    (progByType[pr.Attack || "Program"] ??= []).push(pr));
  // Hacking leads the list — it's what makes a deck run, not a tool run on it.
  const progGroups = Object.entries(progByType)
    .sort(([a], [b]) => (a === RULES.HACKING_PROGRAM_CATEGORY ? -1 : 0)
                      - (b === RULES.HACKING_PROGRAM_CATEGORY ? -1 : 0)
                      || a.localeCompare(b))
    .map(([label, rows]) => ({
      label,
      items: rows.map(pr => ({
        name: pr.Name, cost: Math.round((+pr.Cost || 0) * mult),
        sub: `I/O ${pr["I/O"] || "—"} · Node Control ${pr["Node Control"] || "N"}`
          + (RULES.programSkill(pr.Name) ? ` · Skill: ${RULES.programSkill(pr.Name)}` : "")
          + (pr.Effect ? " · " + pr.Effect : ""),
        hidden: ownedProg.has(pr.Name),
      })),
    }));
  deckBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, "Buy program"),
    categoryBrowser({ id: "buy-programs", groups: progGroups,
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      onAdd: name => {
        const pr = DATA.tables.programs.find(x => x.Name === name) || {};
        const cost = Math.round((+pr.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        CHAR.play.purchases.programs.push(name);
        logCash(`Bought program ${name}`, -cost, { kind: "program", name });
      } })));
  body.append(progCard);
  body.append(deckBuySection);
}

/* ------------------------------------------------ rigging tab */
// Per unit-type config. The weapon/mod table names come from rules.js's
// UNIT_ATTACHMENT_TABLES so the engine, the legacy-attachment migration and this
// UI can't drift apart; only the display bits live here.
const RIG_UNIT_CFG = {
  drones: {
    title: "Drones", table: "drones", nameKey: "Drone",
    weaponTables: RULES.UNIT_ATTACHMENT_TABLES.drones.weapons,
    modTable: RULES.UNIT_ATTACHMENT_TABLES.drones.mods,
    capLabel: "Hard points", capOf: r => toInt(r["Hard Point"]),
  },
  vehicles: {
    title: "Vehicles", table: "vehicles", nameKey: "Vehicle",
    weaponTables: RULES.UNIT_ATTACHMENT_TABLES.vehicles.weapons,
    modTable: RULES.UNIT_ATTACHMENT_TABLES.vehicles.mods,
    capLabel: "Weapon cap", capOf: r => Math.floor(toInt(r.Body) / 3),
  },
};
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

// Scale an ammo value by a multiplier, preserving any non-numeric suffix
// ("40" → "80", "1 missile" → "2 missile", "" → "").
function scaleAmmo(ammo, mult) {
  const m = String(ammo).match(/^(\d+)(.*)$/);
  return m ? (parseInt(m[1], 10) * mult) + m[2] : String(ammo);
}

// A unit mod is either a plain name (unit-scoped, also the legacy shape) or
// {name, weapon: <index>} attached to a specific mounted weapon. These read
// either shape without caring which it is.
const modName = m => (typeof m === "string" ? m : (m && m.name) || "");
const modWeaponIdx = m =>
  (m && typeof m === "object" && Number.isInteger(m.weapon)) ? m.weapon : null;
const modDoublesAmmo = row => !!row && /doubl\w*\s+ammo/i.test(row.ModeEffect || row.Effect || "");

// Remove a mounted weapon and keep weapon-attached mods consistent: drop mods on
// the removed weapon and shift the index of mods attached to later weapons.
function removeUnitWeapon(u, wi, table) {
  u.weapons.splice(wi, 1);
  u.mods = (u.mods || []).reduce((acc, m) => {
    const idx = modWeaponIdx(m);
    if (idx === wi) return acc;
    acc.push(idx != null && idx > wi ? { ...m, weapon: idx - 1 } : m);
    return acc;
  }, []);
  // Firing state is keyed by weapon index too, so close the gap the same way --
  // otherwise the removed gun's magazine and mode are inherited by whichever
  // weapon shifts into its slot.
  const slot = table && (CHAR.play.rigging.units || {})[unitStateKey(table, u)];
  if (slot && slot.guns) {
    const next = {};
    for (const [k, v] of Object.entries(slot.guns)) {
      const idx = +k;
      if (idx === wi) continue;
      next[idx > wi ? idx - 1 : idx] = v;
    }
    slot.guns = next;
  }
  playChangedRecalc();
}

// Flatten a unit's fitted weapons + mods into one attachment list (each with its
// effect) and tally the mod effects that change unit stats. Each name is
// self-classified against the weapon/mod tables, so a mod that slipped into
// u.weapons (older saves) still shows as a mod with the right effect.
function unitAttachments(cfg, unit) {
  const findWeapon = wn => {
    for (const [tk, nc] of cfg.weaponTables) {
      const wr = DATA.tables[tk].find(x => x[nc] === wn);
      if (wr) return wr;
    }
    return null;
  };
  const [mtk, mnc] = cfg.modTable;
  const findMod = mn => DATA.tables[mtk].find(x => x[mnc] === mn) || null;

  const weapons = unit.weapons || [];
  const mods = unit.mods || [];
  // Sort mods into unit-scoped and per-weapon (attached to a mounted weapon).
  // A weapon-scoped mod with no valid target (legacy save) falls back to every
  // weapon, preserving the old "applies to all" behaviour.
  const unitMods = [];
  const weaponMods = weapons.map(() => []);
  for (const m of mods) {
    const nm = modName(m), mr = findMod(nm), idx = modWeaponIdx(m);
    if (idx != null && idx >= 0 && idx < weapons.length) weaponMods[idx].push({ nm, mr });
    else if (mr && mr.Target === "weapon" && weapons.length)
      weapons.forEach((_, wi) => weaponMods[wi].push({ nm, mr }));
    else unitMods.push({ nm, mr });
  }

  const items = [];
  const statMods = { ballistic: 0, impact: 0, hardening: 0, body: 0 };
  // Body deltas can come from a weapon OR a mod (issue #22), so this is tallied
  // across every attachment rather than only unit-scoped mods. An explicit sign
  // is required ("-1 Body") so prose like "Targets make Body test" can't match.
  const tallyBody = text => {
    const m = String(text || "").match(/([+-]\d+)\s*Body/i);
    if (m) statMods.body += toInt(m[1]);
  };
  // Weapons first, each with its attached mods and (if an ammo-doubler is fitted)
  // doubled ammo.
  weapons.forEach((wn, wi) => {
    const wr = findWeapon(wn) || {};
    const doubles = weaponMods[wi].some(x => modDoublesAmmo(x.mr));
    const bits = [];
    if (wr.Damage) bits.push(`DMG ${wr.Damage}`);
    if (wr.Pen && wr.Pen !== "N/A") bits.push(`Pen ${wr.Pen}`);
    if (wr.Ammo) bits.push(`Ammo ${doubles ? scaleAmmo(wr.Ammo, 2) : wr.Ammo}${doubles ? " (×2)" : ""}`);
    const modBits = weaponMods[wi].map(x =>
      x.nm + ((x.mr && (x.mr.ModeEffect || x.mr.Effect)) ? ` (${x.mr.ModeEffect || x.mr.Effect})` : ""));
    items.push({ name: wn, kind: "weapon", stats: bits.join(", "),
      effect: wr.Effect || wr.ModeEffect || "", mods: modBits });
    tallyBody(wr.Effect); tallyBody(wr.ModeEffect);
    weaponMods[wi].forEach(x => x.mr && tallyBody(x.mr.ModeEffect || x.mr.Effect));
  });
  // Unit-scoped mods, tallying the ones that change unit stats.
  for (const { nm, mr } of unitMods) {
    const eff = mr ? (mr.ModeEffect || mr.Effect || "") : "";
    items.push({ name: nm, kind: "mod", stats: "", effect: eff, mods: [] });
    let m;
    if ((m = eff.match(/([+-]?\d+)\s*Ballistic Armor/i))) statMods.ballistic += toInt(m[1]);
    if ((m = eff.match(/([+-]?\d+)\s*Impact Armor/i))) statMods.impact += toInt(m[1]);
    if ((m = eff.match(/([+-]?\d+)\s*(?:Base )?Hardening/i))) statMods.hardening += toInt(m[1]);
    tallyBody(eff);
  }
  // A Speaker's Drone-slot infusion buffs EVERY owned drone, so it folds in here
  // rather than at each call site — that way the Rigging card, the Gear table and
  // the condition tracks (which size themselves from effective Body) all agree.
  // Vehicles are untouched: the column is "Drone".
  const di = (CALC.infusion_mods || {}).drones;
  if (di && cfg.table === "drones") {
    statMods.ballistic += di.ballistic;
    statMods.impact += di.impact;
    statMods.hardening += di.hardening;
    statMods.body += di.body;
    statMods.infusion_move = di.move;
    if (di.ballistic || di.impact || di.hardening || di.body || di.move) {
      items.push({ name: "Spirit infusion", kind: "mod", stats: "",
        effect: [di.ballistic || di.impact ? `+${di.ballistic}B/+${di.impact}I armor` : "",
                 di.hardening ? `+${di.hardening} Hardening` : "",
                 di.body ? `+${di.body} Body` : "",
                 di.move ? `+${di.move}m Movement` : ""].filter(Boolean).join(", "),
        mods: [] });
    }
  }
  return { items, statMods };
}

/* Close the gap in the position-keyed play-state maps after a unit at `removedAt`
   is spliced out of its list: slot n+1 becomes n for every later unit, and the
   now-vacant last slot is dropped. Without this a sold vehicle's damage tracks
   and link flag would be inherited by whatever shifted into its index.
   `newLength` is the list length AFTER the splice. `unit_open` is vestigial (the
   attachment list no longer collapses) but is still shifted so older saves that
   carry the key don't leave stale entries behind. */
function shiftUnitStateDown(table, removedAt, newLength) {
  const rg = CHAR.play.rigging;
  for (const map of [rg.units, rg.linked, rg.active, rg.hotseat, rg.unit_open]) {
    if (!map) continue;
    for (let n = removedAt; n < newLength; n++) {
      const next = map[`${table}:${n + 1}`];
      if (next === undefined) delete map[`${table}:${n}`];
      else map[`${table}:${n}`] = next;
    }
    delete map[`${table}:${newLength}`];
  }
}

/* The three ways a unit can be "out there", all keyed by the same slot:
 *
 *   linked  — riding a VCR link. Limited by the active rig's Links.
 *   active  — deployed WITHOUT a link: it runs itself, costs no link, and its
 *             passive rider (a Shield Drone's dodge reroll, a Bug-Spy's
 *             Observation and Initiative dice) is on the character.
 *   hotseat — the one the player is currently piloting. Its stats belong on the
 *             Overview, above the character's own weapons, because that is what
 *             the player is rolling this round.
 *
 * A linked drone is deployed by definition, so it grants its rider too — the
 * Active box is what a drone running off-link needs to say the same thing.
 */
function rigFlags() {
  const rg = CHAR.play.rigging;
  rg.linked = rg.linked || {};
  rg.active = rg.active || {};
  rg.hotseat = rg.hotseat || {};
  return rg;
}

/* Every unit currently on station, in Rigging-tab order. `onStation` is the
 * linked-or-active test the passive-bonus and summary lists both read. */
function deployedUnits() {
  const rg = rigFlags();
  const out = [];
  [["drones", allDrones()], ["vehicles", allVehicles()]].forEach(([table, list]) => {
    list.forEach((u, i) => {
      const key = `${table}:${i}`;
      const linked = !!rg.linked[key], active = !!rg.active[key];
      // A hotseat flag left over from before the rig was sold reads as empty:
      // you can't be piloting anything without a VCR to jack in with.
      if (linked || active)
        out.push({ table, u, key, linked, active,
          hotseat: !!rg.hotseat[key] && hasVcrRig() });
    });
  });
  return out;
}

/* The passive rider a deployed unit puts on the character, from the data row's
 * Effect column. Free text — reported, never folded into a stat, the same
 * ruling armor Style etiquette bonuses and Blinged vehicles follow. */
function unitPassiveEffect(table, u) {
  const cfg = RIG_UNIT_CFG[table];
  const r = (DATA.tables[table] || []).find(x => x[cfg.nameKey] === u.name) || {};
  return (r.Effect || "").trim();
}

/* Play-state key for a unit's slot in CHAR.play.rigging.units. Keyed by list
   position, matching the `${cfg.table}:${i}` convention the Rigging tab uses. */
/* Damage/state for one drone or vehicle, keyed by its position in the joined
 * chargen-then-play list — the same index CALC uses. Play purchases append, so
 * a chargen unit's key never moves and existing saves keep their state. */
function unitStateKey(table, unit) {
  return `${table}:${allUnits(table).indexOf(unit)}`;
}

/* A unit's Hardening: whatever its data row states (drones and vehicles carry
 * no such column today, so 0) plus anything a fitted mod or a Drone-slot spirit
 * infusion adds. Reported everywhere a unit's stats are, including at 0 — a
 * blank read as "this stat doesn't exist here" (issue #33). */
function unitHardening(row, statMods) {
  return RULES.hardeningOf(row) + toInt((statMods || {}).hardening);
}

/* Effective Body after any weapon/mod deltas — the box count for both condition
   tracks (issue #22). Never below 0; a wrecked chassis still has zero boxes
   rather than a negative track. */
function unitEffectiveBody(cfg, unit) {
  const r = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === unit.name) || {};
  const { statMods } = unitAttachments(cfg, unit);
  return Math.max(0, toInt(r.Body) + statMods.body);
}

/* Per-box repair price for a unit's Physical Condition Track: 1/100th of the
   chassis base price (the table's face Cost — no heritage surcharge). */
function unitRepairCostPerBox(cfg, unit) {
  const r = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === unit.name) || {};
  return Math.round((+r.Cost || 0) / 100);
}

/* The two damage tracks for one unit. `st` is the unit's play-state slot
   (rg.units[key]). Physical damage costs cash to repair; Integrity clears free.
   Rendered as a counter + proportional bar rather than the character sheet's
   box grid: vehicle Body reaches 48, which would be 96 clickable boxes and
   ~500px per unit. A counter is constant height at any Body, and typing "37"
   beats hunting for the 37th box. */
function unitConditionTracks(cfg, unit, st, label) {
  // A shared character is read-only: show both tracks, but no marking, no
  // repairing and no cash movement.
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const max = unitEffectiveBody(cfg, unit);
  st.physical = Math.min(Math.max(0, toInt(st.physical)), max);
  st.integrity = Math.min(Math.max(0, toInt(st.integrity)), max);
  const perBox = unitRepairCostPerBox(cfg, unit);
  const wrap = el("div", { class: "sh-unit-tracks" });
  if (!max) {
    wrap.append(el("p", { class: "hint" },
      "No condition boxes — this chassis has no effective Body."));
    return wrap;
  }

  /* One track: label, counter, "n / max", a proportional fill bar, and whatever
     repair control the track uses. `kind` picks the colour (physical / integrity). */
  const track = (kind, labelText, get, set, note, controls) => {
    const countText = el("span", { class: "sub sh-track-count" }, `${get()} / ${max}`);
    const fill = el("div", { class: `sh-bar-fill ${kind}`,
      style: `width:${max ? (get() / max) * 100 : 0}%` });
    const bar = el("div", { class: "sh-bar", role: "img",
      "aria-label": `${label} ${labelText.toLowerCase()} ${get()} of ${max}` }, fill);
    // miniCounter renders its own label and calls playChanged() itself, so pass
    // an empty one (the coloured label above is ours) and leave the setter pure
    // — matching the Damage / Inertia counters on the same row.
    const counter = ro ? null : miniCounter("", get, v => { set(v); }, 0, max);
    return el("div", { class: "sh-track" },
      el("div", { class: "sh-track-head" },
        el("span", { class: kind === "physical" ? "phys-lbl" : "stun-lbl" }, labelText),
        counter, countText,
        el("span", { class: "sub" }, `· ${note}`)),
      bar,
      ro ? null : controls);
  };

  // --- Physical Condition Track: repaired for cash, per box.
  const repairQty = el("input", { type: "number", min: "1", max: String(max),
    value: "1", class: "sv-edit", style: "width:56px",
    title: "How many boxes to repair" });
  const repairPrice = el("span", { class: "sub" }, "");
  const priceFor = n => `→ ${fmt(Math.max(0, Math.min(st.physical, n || 0)) * perBox)}`;
  const syncPrice = () => {
    repairPrice.textContent = st.physical ? priceFor(parseInt(repairQty.value, 10)) : "";
  };
  repairQty.addEventListener("input", syncPrice);
  syncPrice();
  const repairBtn = el("button", { class: "btn small",
    disabled: st.physical ? null : "1",
    title: st.physical ? `Repair at ${fmt(perBox)} per box` : "No damage to repair",
    onclick: () => {
      const want = Math.max(1, Math.min(st.physical, parseInt(repairQty.value, 10) || 1));
      const cost = want * perBox;
      if (CHAR.play.cash < cost
          && !confirm(`Repairing ${want} box(es) costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
        return;
      st.physical -= want;
      logCash(`Repaired ${want} Physical Condition box(es) on ${label}`, -cost);
      playChangedRecalc();
    } }, "Repair");
  const repairAllBtn = el("button", { class: "btn small",
    disabled: st.physical ? null : "1",
    title: st.physical ? `Repair all ${st.physical} — ${fmt(st.physical * perBox)}` : "No damage to repair",
    onclick: () => {
      const want = st.physical, cost = want * perBox;
      if (CHAR.play.cash < cost
          && !confirm(`Full repair costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
        return;
      st.physical = 0;
      logCash(`Repaired ${want} Physical Condition box(es) on ${label}`, -cost);
      playChangedRecalc();
    } }, "Repair all");
  wrap.append(track("physical", "PHYSICAL CONDITION",
    () => st.physical, v => { st.physical = v; },
    `${fmt(perBox)} per box to repair`,
    el("div", { class: "add-row" }, repairQty, repairBtn, repairPrice, repairAllBtn)));

  // --- Vehicle Integrity Track: same size, free to clear.
  wrap.append(track("integrity", "VEHICLE INTEGRITY",
    () => st.integrity, v => { st.integrity = v; }, "free to repair",
    el("div", { class: "add-row" },
      el("button", { class: "btn small", disabled: st.integrity ? null : "1",
        title: "Clear the whole Integrity track (no cost)",
        onclick: () => { st.integrity = 0; playChangedRecalc(); } }, "Clear all"))));
  return wrap;
}

/* Unit | Stats | Attachments table for drones/vehicles. Shared by the Rigging
   tab (units on station) and the Gear tab (everything owned) so the two never
   drift -- issue #20 was the Gear tab showing only a name and a type. `entries`
   are {table, u} pairs, where table keys RIG_UNIT_CFG.

   `mode` picks the per-row toggle, because the two callers ask different
   questions. The Gear tab is an inventory: "Carried". The on-station list is
   about what you're flying right now: "Hotseat" — carrying a drone you have
   deployed says nothing, and the box that matters there is which one you're in.
   `mode: "station"` also labels how each unit is out (VCR link or Active). */
function unitLoadoutTable(entries, mode = "inventory") {
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Unit"), el("th", {}, "Stats"),
    el("th", {}, "Weapons & mods")));
  entries.forEach(({ table, u }) => {
    const cfg = RIG_UNIT_CFG[table];
    const r = DATA.tables[table].find(x => x[cfg.nameKey] === u.name) || {};
    const { items, statMods } = unitAttachments(cfg, u);
    // Mods can raise armor/hardening — reflect the boosted values here.
    const ball = toInt(r.Ballistic) + statMods.ballistic;
    const imp = toInt(r.Impact) + statMods.impact;
    const body = Math.max(0, toInt(r.Body) + statMods.body);
    const stats = `Move ${r.Move}`
      + (statMods.infusion_move ? ` +${statMods.infusion_move}m (infusion)` : "")
      + ` · Handling ${r.Handling} · Body ${body}`
      + (statMods.body ? ` (base ${r.Body})` : "")
      + ((ball || imp) ? ` · ${ball}B/${imp}I` : "")
      // Hardening always prints, even at 0. Drones and vehicles carry no base
      // Hardening in the data — it only arrives from a fitted mod or a drone
      // infusion — and hiding the zero made the stat look missing rather than
      // absent (issue #33).
      + ` · Hardening ${unitHardening(r, statMods)}`
      + ` · ${cfg.capLabel} ${cfg.capOf(r)}`
      // A condition carrying a gameplay rider (Blinged) reports it here; it is
      // never applied to a stat.
      + (u.condition && RULES.VEHICLE_CONDITION_EFFECTS[u.condition]
          ? ` · ${u.condition}: ${RULES.VEHICLE_CONDITION_EFFECTS[u.condition]}` : "");
    // Damage read-out, so the Gear inventory reflects it too (the interactive
    // tracks live on the Rigging tab).
    const dst = (CHAR.play.rigging.units || {})[unitStateKey(table, u)] || {};
    const dmgLine = body
      ? `Physical ${Math.min(toInt(dst.physical), body)} / ${body}`
        + ` · Integrity ${Math.min(toInt(dst.integrity), body)} / ${body}`
      : "";
    const attachCell = items.length
      ? el("div", {}, ...items.map(it => el("div", { class: "sub", style: "margin:2px 0" },
          el("b", {}, it.name),
          it.kind === "mod" ? el("span", { class: "sh-tag", style: "margin-left:6px" }, "mod") : null,
          it.stats ? ` — ${it.stats}` : "",
          it.effect ? el("span", { style: "color:var(--manon)" },
            `${it.stats ? " · " : " — "}${it.effect}`) : null,
          ...((it.mods && it.mods.length)
            ? [el("div", { style: "margin-left:14px;color:var(--manon)" }, "↳ " + it.mods.join(" · "))]
            : []))))
      : "—";
    const station = mode === "station";
    const key = unitStateKey(table, u);
    const rg = station ? rigFlags() : null;
    t.append(el("tr", {},
      el("td", {}, el("b", {}, u.label || u.name),
        u.label ? el("div", { class: "sub" }, u.name) : null,
        el("div", { class: "sub" }, cfg.title.replace(/s$/, "")),
        station
          ? el("div", {},
              el("div", { class: "sub" },
                rg.linked[key] ? "VCR link" : null,
                (rg.linked[key] && rg.active[key]) ? " · " : null,
                rg.active[key] ? "Active" : null),
              shHotseatToggle(key, u))
          : shCarriedToggle(u)),
      el("td", { class: "sub" }, stats,
        dmgLine ? el("div", { class: "sh-unit-dmg" }, dmgLine) : null),
      el("td", {}, attachCell)));
  });
  return t;
}

function shRigging(body) {
  const rg = rigFlags();
  // The small-heritage surcharge applies to vehicles (below, via unitBlock) but
  // not to VCRs/rigs or drones — those pay face value.
  const base = CALC.budget.gear_cost_multiplier || 1;
  const rigMult = RULES.surchargeFor("rig", base);
  const rigEntries = ownedRigs();
  const rigs = rigEntries.map(e => e.ref);
  if (rigs.length && !rigs.some(r => r.name === rg.active_rig))
    rg.active_rig = rigs[0].name;

  const activeRig = rigs.find(r => r.name === rg.active_rig);
  const linkLimit = activeRig ? RULES.rigStats(activeRig, DATA.tables).links : 0;
  const linkedCount = () => Object.values(rg.linked).filter(Boolean).length;
  // All "buy new unit" browsers collect here and render at the bottom.
  const rigBuySection = el("div", { class: "card sh-card", id: "rig-buy" },
    el("h3", {}, "Buy rigs, drones & vehicles"),
    el("p", { class: "hint" }, "New units are purchased here; configure owned ones above."));

  // --- VCRs
  const rigCard = el("div", { class: "card sh-card" }, el("h3", {}, "Vehicle Control Rigs"));
  rigEntries.forEach((en, ri) => {
    const { ref: r, arr: rigArr, i: rigIndex, inPlay, category } = en;
    const st = RULES.rigStats(r, DATA.tables);
    const isActive = r.name === rg.active_rig;
    const modSub = sublistOf(en, "mods");
    const rigModCost = name => Math.round(
      (+(DATA.tables.rig_mods.find(m => m["Rig Mod"] === name) || {}).Cost || 0) * rigMult);
    const modEditor = fittedCategoryEditor({
      id: `sh-rmods-${ri}-${r.name}`,
      items: modSub.items,
      groups: modGroups(DATA.tables.rig_mods, "Rig Mod", null, "Rig Mods"),
      onAdd: name => {
        const cost = rigModCost(name);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        modSub.add(name);
        logCash(`Fitted ${name} to ${r.name}`, -cost,
          { kind: "rig_mod", host: r.name, name });
      },
      onRemove: index => disposeOfMod({ entry: en, list: "mods", index,
        name: sublistName(modSub.items[index]), hostName: r.name,
        value: rigModCost(sublistName(modSub.items[index])) }),
      effectOf: name => (DATA.tables.rig_mods.find(m => m["Rig Mod"] === name) || {}).Effect || "",
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    });
    rigCard.append(el("div", { class: "sh-unit" },
      el("div", {},
        el("div", { class: "sh-advrow" + (isActive ? " active-row" : ""), style: "border:0;padding:0" },
          el("span", {}, el("b", {}, r.name),
            el("span", { class: "sub" },
              ` +${st.bonusDice}d · Hardening ${st.hardening >= 0 ? "+" : ""}${st.hardening} · Links ${st.links} · Cores ${st.cores}`)),
          isActive ? el("span", { class: "chip ok" }, "Active VCR")
            : counterBtn("Set Active", () => { rg.active_rig = r.name; playChanged(); })),
        el("div", { class: "sh-unit-add" }, el("b", {}, "Mods"), modEditor)),
      el("button", { class: "row-del", title: "Sell / remove VCR",
        onclick: async () => {
          const row = DATA.tables.rigs.find(x => x["Rig Type"] === r.name) || {};
          if (!await disposeOfItem({ category, arr: rigArr, index: rigIndex, inPlay,
            name: r.name, value: Math.round((+row.Cost || 0) * rigMult) })) return;
          if (rg.active_rig === r.name) rg.active_rig = "";
          await playChangedRecalc();
        } }, "✕")));
  });
  if (rigs.length)
    rigCard.append(el("p", { class: "hint" },
      `Active VCR links ${linkedCount()} / ${linkLimit} units.`));
  else
    rigCard.append(el("p", { class: "hint" }, "No rigs owned — drones are piloted unlinked."));
  // buy a new VCR in play
  const rigGroups = [{ label: "Vehicle Control Rigs", items: DATA.tables.rigs.map(x => ({
    name: x["Rig Type"], cost: Math.round((+x.Cost || 0) * rigMult),
    sub: `+${x["Bonus Dice"]}d · Links ${x.Links} · Cores ${x.Cores}` })) }];
  rigBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, "Buy VCR"),
    categoryBrowser({ id: "buy-rigs", groups: rigGroups,
      rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      onAdd: name => {
        const row = DATA.tables.rigs.find(x => x["Rig Type"] === name) || {};
        const cost = Math.round((+row.Cost || 0) * rigMult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        CHAR.play.purchases.rigs.push({ name, mods: [] });
        logCash(`Bought ${name}`, -cost, { kind: "rig", name });
      } })));
  body.append(rigCard);

  // On-station summary: everything riding a VCR link OR running Active.
  // Link keys index the joined list, the same one unitStateKey uses.
  const activeUnits = deployedUnits();
  if (activeUnits.length) {
    body.append(el("div", { class: "card sh-card" },
      el("h3", {}, "Active drones & vehicles"),
      el("p", { class: "hint" },
        "Anything on a VCR link or ticked Active. Hotseat marks the one you're "
        + "piloting — its stats move to the Overview, above your own weapons."),
      unitLoadoutTable(activeUnits, "station")));
  }

  /* `entries` is the joined chargen-then-play list from ownedSplit, so `i` is
     the combined index every play-state key uses and `arr`/`localIndex` is
     where the unit actually lives. New units are always bought into
     play.purchases — the chargen record is closed once Finalize is pressed. */
  const unitBlock = (cfg, entries, calcArr) => {
    const list = entries.map(e => e.ref);
    // Only a vehicle's base chassis carries the small-heritage surcharge; fitted
    // weapons/mods (and everything on a drone) pay face value.
    const baseMult = cfg.table === "vehicles" ? RULES.surchargeFor("vehicle", base) : 1;
    const mult = 1;   // fitted weapons & mods — never surcharged
    const unitReadonly = !!(activeTabObj() && activeTabObj().readonly);
    const card = el("div", { class: "card sh-card" }, el("h3", {}, cfg.title));
    entries.forEach((en, i) => {
      const { arr: unitArr, i: localIndex, inPlay, category } = en;
      // The unit is play's own copy, so reads and writes are the same object.
      const u = en.ref;
      const edit = () => u;
      const r = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === u.name) || {};
      const summary = (calcArr || [])[i] || {};
      const key = `${cfg.table}:${i}`;
      const st = rg.units[key] = rg.units[key] || { inertia: 0, physical: 0, integrity: 0 };
      u.weapons = u.weapons || []; u.mods = u.mods || [];

      // Editable custom name. `type: "text"` matters -- the global input styling
      // is keyed on input[type=text], which a bare <input> does not match, so
      // without it this fell through to the browser's white default box.
      const nameInput = el("input", { type: "text", class: "sh-unit-name",
        value: u.label || "", placeholder: u.name,
        title: `Rename this ${cfg.title.replace(/s$/, "").toLowerCase()} (blank uses "${u.name}")`,
        onchange: e => { u.label = e.target.value.trim(); playChanged(); } });

      const findWeapon = wn => {
        for (const [tk, nc] of cfg.weaponTables) {
          const wr = DATA.tables[tk].find(x => x[nc] === wn);
          if (wr) return wr;
        }
        return null;
      };
      const [mtk, mnc] = cfg.modTable;
      const findMod = mn => DATA.tables[mtk].find(x => x[mnc] === mn) || null;
      const weaponScopedMods = DATA.tables[mtk].filter(x => x.Target === "weapon");
      const unitScopedMods = DATA.tables[mtk].filter(x => x.Target !== "weapon");
      const buyMod = (name, targetLabel) => {
        const mr = findMod(name) || {};
        const cost = Math.round((+mr.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return false;
        logCash(`Fitted ${name} to ${targetLabel}`, -cost);
        return true;
      };
      // Classify existing mods: those attached to a weapon vs unit-scoped (which
      // also catches legacy untargeted mods so they stay removable).
      const weaponModIdx = u.weapons.map(() => []);
      const unitModIdx = [];
      u.mods.forEach((m, mi) => {
        const wi = modWeaponIdx(m);
        if (wi != null && wi >= 0 && wi < u.weapons.length) weaponModIdx[wi].push(mi);
        else unitModIdx.push(mi);
      });

      // fitted weapons — each shows its stats, effect, its attached weapon-mods
      // (with removal), doubled ammo when an ammo-mod is attached, and a picker
      // for weapon-scoped mods bound to that specific weapon.
      const weaponRows = u.weapons.map((wn, wi) => {
        const wr = findWeapon(wn) || {};
        const doubles = weaponModIdx[wi].some(mi => modDoublesAmmo(findMod(modName(u.mods[mi]))));
        const ammo = wr.Ammo ? (doubles ? `${scaleAmmo(wr.Ammo, 2)} (×2)` : wr.Ammo) : "";
        const effect = wr.Effect || wr.ModeEffect || "";
        const modChips = weaponModIdx[wi].map(mi => {
          const nm = modName(u.mods[mi]);
          return el("span", { class: "chip", style: "margin:2px 4px 0 0;cursor:pointer",
            title: "Sell or remove mod",
            onclick: () => disposeOfUnitMod(en, mi, nm, wn,
              Math.round((+(findMod(nm) || {}).Cost || 0) * mult)) },
            nm + " ✕");
        });
        const addWeaponMod = weaponScopedMods.length ? fittedCategoryEditor({
          id: `rig-wm-${key}-${wi}`, items: [],
          groups: modGroups(weaponScopedMods, mnc, null, "Weapon mods"),
          onAdd: name => { if (buyMod(name, wn)) edit().mods.push({ name, weapon: wi }); },
          onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
        }) : null;
        // Energy mounts run on Heat and carry no Modes/Ammo columns at all.
        const isEnergy = wr["Heat Limit"] !== undefined || wr.Heat !== undefined;
        const fireCtl = unitGunControls(cfg.table, u, wi, wn, wr, isEnergy);
        // The loaded round shifts what the mount actually puts downrange.
        const uAmmo = isEnergy ? { row: null, name: "", mods: RULES.ammoStatMods(""), notes: [] }
                               : unitLoadedAmmo(cfg.table, u, wi, wn);
        const uBase = { acc: wr.Accuracy || 0, damage: wr.Damage || "—", pen: wr.Pen || 0 };
        const uShot = uAmmo.row ? RULES.applyAmmoStats(uBase, uAmmo.mods) : uBase;
        const uBit = (label, key) => el("span",
          (uAmmo.row && String(uShot[key]) !== String(uBase[key]))
            ? { class: "wpn-ammo-mod", title: `${uAmmo.name} loaded` } : {},
          `${label} ${uShot[key]}`);
        return el("div", { class: "sub", style: "margin:4px 0" },
          el("span", { class: "chip", style: "cursor:pointer", title: "Sell or remove weapon",
            onclick: async () => {
              const result = await promptDisposal(wn,
                Math.round((+(findWeapon(wn) || {}).Cost || 0) * mult));
              if (!result) return;
              removeUnitWeapon(edit(), wi, cfg.table);
              logCash(`${result.sold ? "Sold" : "Lost"} ${wn} (off ${u.label || u.name})`,
                result.sold ? result.amount : 0);
              await playChangedRecalc();
            } }, wn + " ✕"),
          " ", uBit("DMG", "damage"), " · ", uBit("Acc", "acc"),
          (ammo ? ` · Mag ${ammo}` : ""),
          wr.Pen ? el("span", {}, " · ") : null, wr.Pen ? uBit("Pen", "pen") : null,
          fireCtl,
          uAmmo.notes.length
            ? el("div", { class: "sub wpn-ammo-note", style: "margin-left:4px" },
                `${uAmmo.name}: ${uAmmo.notes.join(" · ")}`) : null,
          effect ? el("div", { class: "sub", style: "margin:2px 0 0 4px;color:var(--manon)" }, effect) : null,
          modChips.length ? el("div", { style: "margin:2px 0 0 4px" }, ...modChips) : null,
          addWeaponMod ? el("div", { class: "sub", style: "margin:2px 0 0 4px" },
            el("b", {}, "Weapon mod "), addWeaponMod) : null);
      });

      // unit-scoped mods (armor, hardening, …)
      const modRows = unitModIdx.map(mi => {
        const nm = modName(u.mods[mi]);
        const mr = findMod(nm) || {};
        const effect = mr.Effect || mr.ModeEffect || "";
        return el("div", { class: "sub" },
          el("span", { class: "chip", style: "margin:2px 4px 0 0;cursor:pointer",
            title: "Sell or remove mod",
            onclick: () => disposeOfUnitMod(en, mi, nm, u.label || u.name,
              Math.round((+mr.Cost || 0) * mult)) }, nm + " ✕"),
          effect ? el("span", { style: "color:var(--manon)" }, effect) : null);
      });

      // add-weapon picker (nested by weapon table)
      const weaponGroups = cfg.weaponTables.map(([tk, nc]) => ({
        label: nc.replace(cfg.nameKey, "").trim() || nc,
        items: DATA.tables[tk].map(x => ({ name: x[nc], cost: Math.round((+x.Cost || 0) * mult),
          sub: `DMG ${x.Damage || "—"}${x.Ammo ? " · Ammo " + x.Ammo : ""}`
            + ((x.Effect || x.ModeEffect) ? " · " + (x.Effect || x.ModeEffect) : "") })),
      }));
      const addWeapon = fittedCategoryEditor({
        id: `rig-w-${key}`, items: [], groups: weaponGroups,
        onAdd: name => {
          const wr = findWeapon(name) || {};
          const cost = Math.round((+wr.Cost || 0) * mult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
          edit().weapons.push(name);
          logCash(`Mounted ${name} on ${u.label || u.name}`, -cost);
        },
        onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      });
      // unit-level add-mod picker (unit-scoped mods only; weapon mods are added
      // per-weapon above)
      const addMod = fittedCategoryEditor({
        id: `rig-m-${key}`, items: [],
        groups: modGroups(unitScopedMods, mnc, null, `${cfg.nameKey} Mods`),
        onAdd: name => { if (buyMod(name, u.label || u.name)) edit().mods.push(name); },
        onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      });

      // link-to-VCR toggle (capped at the active VCR's links)
      const isLinked = !!rg.linked[key];
      const linkToggle = el("label", { class: "opt" },
        el("input", { type: "checkbox", ...(isLinked ? { checked: 1 } : {}),
          disabled: (!activeRig || (!isLinked && linkedCount() >= linkLimit)) ? "1" : null,
          onchange: e => {
            if (e.target.checked && linkedCount() >= linkLimit) {
              alert(`Active VCR links only ${linkLimit} unit(s).`); e.target.checked = false; return;
            }
            rg.linked[key] = e.target.checked; playChanged();
            renderSheet();       // the on-station list and Overview both follow this
          } }),
        el("span", {}, isLinked ? "Linked to VCR" : "Link to VCR"));
      // Running off-link. Costs no VCR link and takes no rig, but the drone is
      // out there, so its passive rider is on the character. Drones only —
      // a vehicle nobody is driving isn't doing anything for you.
      const isActive = !!rg.active[key];
      const passive = unitPassiveEffect(cfg.table, u);
      const activeToggle = cfg.table === "drones" ? el("label", { class: "opt",
          title: passive ? `Deployed off-link — grants: ${passive}`
                         : "Deployed off-link (this drone has no passive effect of its own)" },
        el("input", { type: "checkbox", ...(isActive ? { checked: 1 } : {}),
          onchange: e => {
            rg.active[key] = e.target.checked; playChanged();
            renderSheet();
          } }),
        el("span", {}, "Active")) : null;

      // Weapons + mods live in their own column (below), so they're always
      // visible alongside the condition tracks instead of collapsed.
      const wCount = u.weapons.length, mCount = u.mods.length;
      const attachments = el("div", { class: "sh-unit-attach" },
        el("div", { class: "sh-attach-head" },
          `Weapons & mods (${wCount} weapon${wCount === 1 ? "" : "s"}, ${mCount} mod${mCount === 1 ? "" : "s"})`),
        weaponRows.length ? el("div", {}, ...weaponRows) : null,
        modRows.length ? el("div", { class: "sub" }, el("b", {}, "Mods:"), ...modRows) : null,
        (!weaponRows.length && !modRows.length)
          ? el("p", { class: "hint" }, "Nothing fitted yet.") : null,
        el("div", { class: "sh-unit-add" },
          el("div", { class: "sub" }, el("b", {}, "Add weapon"), addWeapon),
          el("div", { class: "sub" }, el("b", {}, "Add unit mod"), addMod)));

      const removeBtn = el("button", { class: "row-del", title: "Sell / remove unit",
        onclick: async () => {
          // The unit's own resale value uses the unit multiplier, not the
          // fitted-weapon `mult` (which is deliberately 1 in this scope).
          if (!await disposeOfItem({ category, arr: unitArr, index: localIndex, inPlay,
            name: u.label || u.name, value: Math.round((+r.Cost || 0) * baseMult) })) return;
          // Per-unit play state is keyed by position in the JOINED list, so
          // losing a unit has to shift every later unit's slot down — otherwise
          // its damage tracks (and the linked flag) land on the wrong vehicle.
          // `entries.length - 1` is that list's length once this one is gone.
          shiftUnitStateDown(cfg.table, i, entries.length - 1);
          await playChangedRecalc();
        } }, "✕");

      card.append(el("div", { class: "sh-unit" },
        el("div", { class: "sh-unit-main" },
          el("div", { class: "sh-unit-title" }, nameInput, removeBtn),
          el("div", { class: "sub" }, el("b", {}, u.name), " · ",
            (() => {
              // Move moved out to its own box beside Inertia — it's the stat you
              // reach for constantly in a chase, so it shouldn't be buried here.
              const sm = unitAttachments(cfg, u).statMods;
              const ball = toInt(r.Ballistic) + sm.ballistic, imp = toInt(r.Impact) + sm.impact;
              const eBody = Math.max(0, toInt(r.Body) + sm.body);
              return `Handling ${r.Handling} · Body ${eBody}`
                + (sm.body ? ` (base ${r.Body})` : "")
                + ((ball || imp) ? ` · Armor ${ball}B/${imp}I` : "")
                + ` · Hardening ${unitHardening(r, sm)}`
                + ` · weapons ${summary.weapon_count ?? u.weapons.length}/${summary.weapon_cap ?? cfg.capOf(r)}`;
            })()),
          r.Effect ? el("div", { class: "sub", style: "color:var(--manon)" }, r.Effect) : null,
          vehicleConditionSelect(u, () => playChangedRecalc()),
          // Physical Condition + Vehicle Integrity tracks (issue #22), then
          // Inertia sitting with them. Inertia is a free-form tally the engine
          // never reads — it's a place to note momentum during a chase. The old
          // Damage counter alongside it was retired: it duplicated the Physical
          // Condition track but was uncapped and equally inert.
          unitConditionTracks(cfg, u, st, u.label || u.name),
          el("div", { class: "sh-unit-ctr sh-unit-inertia" },
            // Move gets its own tile: it's read constantly during a chase, and
            // it's derived (base + any Drone-infusion bonus) so it's a readout,
            // not a counter.
            (() => {
              const bonus = unitAttachments(cfg, u).statMods.infusion_move || 0;
              const base = String(r.Move || "0");
              const num = parseInt(base, 10);
              const unit = base.replace(/^\d+\s*/, "") || "m";
              return el("div", { class: "sh-unit-stat" + (bonus ? " boosted" : ""),
                title: bonus ? `${base} base +${bonus}m from a spirit infusion` : "Movement rate" },
                el("span", { class: "lbl" }, "Move"),
                el("b", {}, Number.isFinite(num) ? `${num + bonus}${unit}` : base),
                bonus ? el("span", { class: "delta" }, `+${bonus}`) : null);
            })(),
            unitReadonly
              // Read-only shares report the value but can't edit it, matching
              // the condition tracks above.
              ? el("span", { class: "sub" }, `Inertia ${toInt(st.inertia)}`)
              : miniCounter("Inertia", () => st.inertia, v => { st.inertia = v; })),
          // No effect text beside the box: the unit's own stat line above
          // already carries it, and printing it twice on one row is the noise
          // the armor rows were just cleaned up for. The tooltip says it.
          activeRig ? linkToggle : null,
          activeToggle),
        attachments));
    });
    if (!entries.length) card.append(el("p", { class: "hint" }, `No ${cfg.title.toLowerCase()} owned.`));
    body.append(card);

    // buy a new unit — rendered in the bottom Buy section
    const buyGroups = [{ label: cfg.title, items: DATA.tables[cfg.table].map(x => ({
      name: x[cfg.nameKey], cost: Math.round((+x.Cost || 0) * baseMult),
      sub: `Body ${x.Body} · Move ${x.Move} · Handling ${x.Handling}` })) }];
    rigBuySection.append(el("div", { class: "sh-unit-add" }, el("b", {}, `Buy new ${cfg.title.toLowerCase().replace(/s$/, "")}`),
      categoryBrowser({ id: `buy-${cfg.table}`, groups: buyGroups,
        rerender: renderSheet, afterAdd: () => playChangedRecalc(),
        onAdd: name => {
          const row = DATA.tables[cfg.table].find(x => x[cfg.nameKey] === name) || {};
          const cost = Math.round((+row.Cost || 0) * baseMult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
          CHAR.play.purchases[cfg.table].push({ name, weapons: [], mods: [] });
          logCash(`Bought ${name}`, -cost, { kind: cfg.table.replace(/s$/, ""), name });
        } })));
  };
  unitBlock(RIG_UNIT_CFG.drones, ownedDrones(), CALC.drones);
  unitBlock(RIG_UNIT_CFG.vehicles, ownedVehicles(), CALC.vehicles);
  body.append(rigBuySection);
}

/* ------------------------------------------------ actions tab */
/* Player reference: common actions and their skill/difficulty, straight from
 * DATA.tables.hack_actions. Grouped by the table's Group column so future
 * action categories land here automatically. */
function actionRefCard(section) {
  if (!section) return null;
  return el("div", { class: "card sh-card" },
    el("h3", {}, section.title),
    section.note ? el("p", { class: "hint" }, section.note) : null,
    el("ul", { class: "sh-bullets" }, ...section.items.map(item => el("li", {}, item))));
}

function shActions(body) {
  const ref = DATA.action_reference || {};

  const pairRow = (...keys) =>
    el("div", { class: "sh-two" }, ...keys.map(k => actionRefCard(ref[k])));

  body.append(
    pairRow("free_actions", "reflex_actions"),
    pairRow("simple_actions", "complex_actions"),
    actionRefCard(ref.conflict_sequence),
    pairRow("resolving_ranged", "resolving_melee"));

  const groups = {};
  for (const row of DATA.tables.hack_actions || [])
    (groups[row.Group || "Actions"] ??= []).push(row);
  if (!Object.keys(groups).length) {
    body.append(el("div", { class: "card sh-card" },
      el("h3", {}, "Actions"),
      el("p", { class: "hint" }, "No action reference data available.")));
    return;
  }
  for (const [group, rows] of Object.entries(groups)) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Action"), el("th", {}, "Skill"),
      el("th", {}, "Difficulty"), el("th", {}, "Notes")));
    for (const r of rows) {
      t.append(el("tr", {},
        el("td", {}, el("b", {}, r.Action)),
        el("td", {}, RULES.hackActionSkill(r.Skill)),
        el("td", { class: "sub" }, r.Diff),
        el("td", { class: "sub" }, r.Notes || "")));
    }
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, group), t,
      el("p", { class: "hint", style: "margin-top:8px" },
        "Difficulties listed as a/b/c/d scale by site tier. (n) is a minimum Alert raise.")));
  }
}

/* ------------------------------------------------ notes tab */
function shNotes(body) {
  const autos = dossierNotes();
  if (autos.length) {
    const card = el("div", { class: "card sh-card" },
      el("h3", {}, "Dossier Notes"),
      el("p", { class: "hint" }, "Generated from your build — reminders that don't fit the other tabs."));
    autos.forEach(n => card.append(el("div", { class: "sh-callout" }, "⚠ ", n)));
    body.append(card);
  }
  const traits = heritageTraitsCard();
  if (traits) body.append(traits);
  body.append(imagesCard());
  body.append(notesCard(18));
}

/* All heritage traits (features + uplift animal) with their listed effects. */
/* [name, effect] for the character's uplift type + each chosen heritage feature. */
function heritageTraitEntries() {
  const feats = DATA.tables.heritage_features || [];
  const rowOf = name => feats.find(f => f.Name === name);
  const traitEffect = f => f.Effects
    || ["STR", "BOD", "REA", "INT", "WILL", "CHA"]
        .filter(k => f[k]).map(k => `${k} ${f[k] > 0 ? "+" : ""}${f[k]}`).join(", ")
    || "—";
  const entries = [];
  if (CHAR.heritage.uplift_type) {
    const f = rowOf(CHAR.heritage.uplift_type);
    if (f) entries.push([`${f.Name} (uplift)`, traitEffect(f)]);
  }
  (CHAR.heritage.features || []).forEach(name => {
    const f = rowOf(name);
    entries.push([name, f ? traitEffect(f) : "—"]);
  });
  return entries;
}

/* Compact "Name: effect" strings for the header, skipping empty effects. */
function heritageAbilityLines() {
  return heritageTraitEntries()
    .filter(([, effect]) => effect && effect !== "—")
    .map(([name, effect]) => `${name.replace(" (uplift)", "")}: ${effect}`);
}

function heritageTraitsCard() {
  const entries = heritageTraitEntries();
  if (!entries.length) return null;
  const card = el("div", { class: "card sh-card" },
    el("h3", {}, "Heritage Traits"),
    el("p", { class: "hint" }, `${CHAR.heritage.type}${CHAR.heritage.uplift_type ? " · " + CHAR.heritage.uplift_type : ""} — trait effects for quick reference.`));
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Trait"), el("th", {}, "Effect")));
  entries.forEach(([name, effect]) =>
    t.append(el("tr", {}, el("td", {}, el("b", {}, name)), el("td", { class: "sub" }, effect))));
  card.append(t);
  const beast = beastDiceTracker();
  if (beast) card.append(beast);
  return card;
}

/* Wildling's beast dice: six of them, spent through a shift and back to six
 * when it ends. There's nothing in the engine to derive them from — they're a
 * pool you burn at the table — so they live in play state and get a stepper and
 * a reset right where the trait is described (issue #31). */
const BEAST_DICE_MAX = 6;
function beastDiceTracker() {
  if (CHAR.heritage.type !== "Green"
      || !(CHAR.heritage.features || []).includes("Wildling")) return null;
  const play = CHAR.play;
  if (play.beast_dice == null) play.beast_dice = BEAST_DICE_MAX;
  const left = Math.max(0, Math.min(BEAST_DICE_MAX, play.beast_dice));
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  return el("div", { class: "sh-advrow", style: "border:0;padding:8px 0 0" },
    el("div", { class: "stat-line" },
      el("span", {}, "Beast dice",
        el("div", { class: "sub" }, "+6 Brawn/Finesse, −3 Focus/Resolve in man-beast form")),
      el("span", { style: "text-align:right;display:inline-flex;align-items:center;gap:8px" },
        el("b", { style: left ? "color:var(--ok)" : "color:var(--bad)" },
          `${left} / ${BEAST_DICE_MAX}`),
        ro ? null : miniCounter("", () => play.beast_dice ?? BEAST_DICE_MAX,
          v => { play.beast_dice = v; }, 0, BEAST_DICE_MAX),
        ro ? null : counterBtn("↻", () => { play.beast_dice = BEAST_DICE_MAX; playChanged(); },
          "good"))));
}

/* ------------------------------------------------ markdown export (scabard.com) */
function exportMarkdown() {
  const md = buildMarkdown();
  const blob = new Blob([md], { type: "text/markdown" });
  const a = el("a", { href: URL.createObjectURL(blob),
    download: (CHAR.name || "character").replace(/[^\w-]+/g, "-") + ".md" });
  a.click();
}

function buildMarkdown() {
  const play = CHAR.play;
  const econ = kismetEcon();
  const c = CALC.combat;
  const L = [];
  const heritageLabel = CHAR.heritage.type
    + (CHAR.heritage.uplift_type ? ` (${CHAR.heritage.uplift_type})` : "");

  L.push(`# ${CHAR.name || "Unnamed"}`);
  L.push("");
  L.push(`*${heritageLabel} · ${CALC.magic.type}${CHAR.player ? ` · Player: ${CHAR.player}` : ""}*`);
  L.push("");

  // ---- compact stat block: attributes, pools, and combat vitals at a glance ----
  const altMoves = (c.move_modes || []).map(m => `${m.mode} ${m.meters}m`).join(", ");
  const initEx = sheetInitiative();
  L.push(ATTR_ABBR.map(([full, ab]) => `**${ab}** ${CALC.attributes[full].final}`).join(" · "));
  L.push("");
  L.push(POOL_ORDER.map(p => `**${p}** ${CALC.pools[p]}`).join(" · "));
  L.push("");
  L.push([
    `**Physical** ${CALC.condition.physical} · **Stun** ${CALC.condition.stun}`,
    `**Armor** ${c.ballistic_armor}B/${c.impact_armor}I`,
    `**Move** ${c.move}m${moveSpecial() ? ` (${moveSpecial()})` : ""}${altMoves ? ` [${altMoves}]` : ""}`,
    `**Init** ${initEx.dice}d+${initEx.bonus}`,
    `**Actions** ${c.simple_actions}`,
    `**Recoil** ${c.recoil_capacity}${c.recoil_ignored ? " (ignored)" : ""}`,
    c.dodge_bonus ? `**Dodge** +${c.dodge_bonus}` : null,
    c.soak_bonus ? `**Soak** +${c.soak_bonus}d` : null,
    c.physical_damage_reduction ? `**Soak** −${c.physical_damage_reduction}` : null,
  ].filter(Boolean).join(" · "));
  if (CALC.martial_art.style && (c.martial_notes || []).length)
    L.push(`**${CALC.martial_art.style}**: ${c.martial_notes.join(" · ")}`);
  L.push("");
  const notes = dossierNotes();
  if (notes.length) { for (const note of notes) L.push(`> ⚠ ${note}`); L.push(""); }
  L.push("*Wound rule: every 3 boxes marked on either track = −1 die on tasks, cumulative. Biotech can remove these penalties during combat.*");
  L.push("");

  L.push("## Skills");
  L.push("");
  // A specialization splits the rating the way the sheet shows it — −1 off it,
  // +1 on it — so the export carries both numbers and what the specialty is,
  // rather than a single figure that is right in neither case.
  const mdSpec = n => {
    const spec = (CHAR.skill_specializations || {})[n];
    return (spec && spec.on && CALC.skills[n].final > 0 && spec.text) ? spec : null;
  };
  let anySpec = false;
  for (const pool of POOL_ORDER) {
    const trained = Object.entries(DATA.skills)
      .filter(([n, m]) => m.pool === pool && CALC.skills[n].final > 0)
      .sort((a, b) => CALC.skills[b[0]].final - CALC.skills[a[0]].final);
    if (!trained.length) continue;
    L.push(`**${pool} (${CALC.pools[pool]}d)**: `
      + trained.map(([n]) => {
          const final = CALC.skills[n].final;
          const spec = mdSpec(n);
          if (!spec) return `${n} ${final}`;
          anySpec = true;
          return `${n} ${final - 1}/${final + 1} (${spec.text})`;
        }).join(" · "));
    L.push("");
  }
  if (anySpec) {
    L.push("*Specialized skills read **off-specialty / on-specialty** — the "
      + "specialty in brackets is the +1 side.*");
    L.push("");
  }
  const skillNoteLines = [];
  for (const [n, s] of Object.entries(CALC.skills))
    if (s.notes && s.notes.length) skillNoteLines.push(`- **${n}** — ${s.notes.join("; ")}`);
  if (skillNoteLines.length) {
    L.push("*Situational skill dice:*");
    skillNoteLines.forEach(line => L.push(line));
    L.push("");
  }
  const etqList = Object.entries(CHAR.etiquettes || {}).filter(([, v]) => v > 0);
  if (etqList.length) {
    L.push("**Etiquettes:** " + etqList.map(([n, v]) => `${n} ${v}`).join(" · "));
    L.push("");
  }
  // Bling reads as one bonus per etiquette however many blinged things you own.
  for (const b of (c.bling_etiquette || [])) {
    L.push(`**Bling:** +${b.bonus} ${b.etiquette} Etiquette when you're showing it off `
      + `— best single source, not cumulative (${b.sources.join(", ")})`);
    L.push("");
  }
  const knows = allKnowledgeSkills().filter(k => k.name);
  if (knows.length) {
    L.push("**Knowledges:** " + knows.map(k => `${k.name} ${k.points || 0}`).join(" · "));
    L.push("");
  }
  const ritualList = Object.entries(CALC.ritual_skills || {}).filter(([, v]) => v > 0);
  if (ritualList.length) {
    L.push("**Ritual skills:** " + ritualList.map(([n, v]) => `${n} ${v}`).join(" · "));
    L.push("");
  }
  for (const m of (CALC.martial_arts || [])) {
    L.push(`**Martial Art — ${m.style} (rank ${m.rank}):** `
      + (m.levels.length ? m.levels.map(l => `L${l.Level}: ${l.Effect}`).join("; ") : "no levels unlocked yet"));
    L.push("");
  }

  const allSpells = [...CHAR.magic.spells, ...play.purchases.spells];
  const allPowers = [...CHAR.magic.amp_powers, ...play.purchases.amp_powers];
  if (CALC.magic.type !== "Hedge") {
    L.push(`## Magic — ${CALC.magic.type}`);
    L.push("");
    if (allSpells.length) {
      const zp = CALC.zoetics.zp;
      L.push("**Spells** (drain is LETHAL above ZP " + zp + ", Stun at or below): "
        + allSpells.map(s => {
            const force = s.force + (play.spell_force_advances[s.name] || 0);
            return `${s.name} (F${force}${force > zp ? " ⚠lethal" : ""})`;
          }).join(" · "));
    }
    if (allPowers.length)
      L.push("**Amp powers:** " + allPowers.map(p =>
        p.name + (p.target ? ` → ${p.target}` : "") + ((p.times || 1) > 1 ? ` ×${p.times}` : "")).join(" · "));
    if (CHAR.speaker.relationships.length)
      L.push("**Spirit relationships:** " + CHAR.speaker.relationships.join(" · ")
        + ` (bonds: ${CHAR.speaker.bonds || 0})`);
    if (CHAR.speaker.infusions.length)
      L.push("**Infusions:** " + CHAR.speaker.infusions.join(" · "));
    // Bound spirits carry their Force and the services they're currently owed
    // for; the full writeup stays in the app rather than bloating the export.
    // Only the bonds actually bought — dormant slots past the count are held
    // for a restore, not bonds this character has.
    const liveBonds = (play.bond_slots || []).slice(0, RULES.speakerBondCount(CHAR));
    for (const [bi, bond] of liveBonds.entries()) {
      if (!bond.spirit) continue;
      const row = DATA.tables.speaker_spirits.find(x => x.Spirit === bond.spirit) || {};
      const names = parseSpiritServices(row["Bound Services"])
        .map(svc => svc.name).filter(Boolean);
      L.push(`**Bond ${bi + 1}:** ${bond.spirit} (Force ${bond.force || 0}`
        + `, favors owed ${bond.favors || 0})`
        + (names.length ? " — " + names.join(" · ") : ""));
    }
    L.push("");
  }

  const allAugments = allAugmentsOwned();
  if (allAugments.length) {
    L.push("## Augments");
    L.push("");
    allAugments.forEach(a => {
      const r = DATA.tables.augments.find(x => x.Name === a.name) || {};
      const dmg = RULES.augmentMeleeDamage(r, CALC.attributes.Strength.final, CALC.martial_art && CALC.martial_art.mods);
      const gun = (a.name === "Cybergun Installation" && a.gunType) ? ` — ${a.gunType}` : "";
      L.push(`- ${a.name}${(a.count || 1) > 1 ? ` ×${a.count}` : ""}${gun}${dmg !== "" ? ` — DMG ${dmg}` : ""}`);
    });
    if (c.sense_notes && c.sense_notes.length)
      L.push(`- *Senses & immunities:* ${c.sense_notes.map(s => s.name).join(", ")}`);
    L.push("");
  }
  const cyberguns = equippedCyberguns();
  const grantedWeapons = c.granted_weapons || [];
  const traitGear = c.trait_gear || [];
  const mdWeapons = allWeapons(), mdArmor = allArmor();
  if (mdWeapons.length || cyberguns.length || grantedWeapons.length || traitGear.length) {
    L.push("## Weapons");
    L.push("");
    mdWeapons.forEach(w => {
      const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
      const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
      const smart = (calcRow.smart ?? w.smart) ? " (smart)" : "";
      const isMelee = r.Type === "Melee";
      const ammo = calcRow.Ammo ?? r.Ammo;
      const bar = String(calcRow.Bar ?? r.Bar ?? "");
      const stats = [`DMG ${calcRow.Damage ?? r.Damage ?? "—"}`,
                     isMelee ? `Reach ${r.Reach || 0}` : `Acc ${calcRow.Accuracy ?? r.Accuracy ?? 0}`,
                     `Pen ${r.Pen || 0}`,
                     (bar || r.Type === "GrenadeLauncher") ? `Barrier ${bar || "—"}` : null,
                     `Conceal ${r.Conceal || 0}`,
                     (!isMelee && ammo) ? `Ammo ${ammo}` : null,
                     (!isMelee && r["Firing modes"]) ? r["Firing modes"] : null].filter(Boolean).join(" · ");
      L.push(`- **${w.name}**${smart} — ${stats}`
        + ((w.mods || []).length ? ` — mods: ${w.mods.join(", ")}` : ""));
    });
    cyberguns.forEach(cg => {
      const g = cg.gun;
      L.push(`- **${cg.name}** (smart) — DMG ${g.Dmg} · Acc ${g.Acc} · Pen ${g.Pen}${barrierBit(g, g.Bar)} · Ammo ${g.Ammo} · ${g.Modes}`);
    });
    grantedWeapons.forEach(gw => {
      const line = gw.stats
        || `${gw.kind || "Melee"}${gw.dice != null ? ` ${gw.dice}d` : ""} · DMG ${gw.damage}`
           + (gw.note ? ` · ${gw.note}` : ` · Reach ${gw.reach}`);
      L.push(`- **${gw.name}** — ${line} (${gw.source})`);
    });
    traitGear.forEach(g => {
      const w = g.weapon;
      L.push(g.kind === "weapon" && w
        ? `- **${g.label}** — ${w.Type || ""} · DMG ${w.Damage || "—"} · Acc ${w.Accuracy || 0} · wt ${w.Weight || 0} (${g.source} mount)`
        : `- **${g.label}** — extra limb (${g.source} mount)`);
    });
    if (c.optics_notes && c.optics_notes.length) L.push(`- *Optics:* ${c.optics_notes.join(" · ")}`);
    L.push("");
  }
  if (mdArmor.length) {
    L.push("## Armor");
    L.push("");
    mdArmor.forEach(a => {
      const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
      L.push(`- **${a.name}** — ${r.Ballistic || 0}B/${r.Impact || 0}I${a.active !== false ? " (worn)" : ""}`);
    });
    L.push("");
  }
  const gearOwned = allGear();
  if (gearOwned.length || play.lifestyles.length) {
    L.push("## Gear");
    L.push("");
    gearOwned.forEach(g => L.push(`- ${g.name}${(g.qty || 1) > 1 ? ` ×${g.qty}` : ""}`));
    play.lifestyles.forEach(ls => {
      L.push(`- Lifestyle: ${ls.name} — ${ls.months || 0} month(s) prepaid${ls.active ? " **(current)**" : ""}`);
      if (ls.active && LIFESTYLE_EFFECTS[ls.name])
        L.push(`  - *Effect:* ${LIFESTYLE_EFFECTS[ls.name]}`);
    });
    L.push("");
  }
  const mdDecks = allDecks(), mdPrograms = allPrograms();
  const mdRigs = allRigs(), mdDrones = allDrones(), mdVehicles = allVehicles();
  if (mdDecks.length || mdPrograms.length) {
    L.push("## Decking");
    L.push("");
    mdDecks.forEach(d => L.push(`- Deck: **${d.name}**${(d.mods || []).length ? ` (${d.mods.join(", ")})` : ""}`
      + (d.hacking ? ` — running ${d.hacking}` : " — **no Hacking program slotted**")));
    if (mdPrograms.length) L.push("- Programs: " + mdPrograms.join(" · "));
    L.push("");
  }
  if (mdRigs.length || mdDrones.length || mdVehicles.length) {
    L.push("## Rigging");
    L.push("");
    // A unit's condition and fitted mods are half of what it is — a Blinged,
    // reframed bike is not the Motorcycle off the page — so they travel with it.
    const unitBits = u => [
      (u.condition && u.condition !== "Pristine") ? u.condition : "",
      (u.weapons || []).length ? `weapons: ${u.weapons.map(sublistName).join(", ")}` : "",
      (u.mods || []).length ? `mods: ${u.mods.map(sublistName).join(", ")}` : "",
    ].filter(Boolean).join(" · ");
    const unitLine = (kind, u) => {
      const bits = unitBits(u);
      L.push(`- ${kind}: **${u.label || u.name}**`
        + (u.label && u.name && u.label !== u.name ? ` (${u.name})` : "")
        + (bits ? ` — ${bits}` : ""));
    };
    mdRigs.forEach(r => unitLine("Rig", r));
    mdDrones.forEach(d => unitLine("Drone", d));
    mdVehicles.forEach(v => unitLine("Vehicle", v));
    L.push("");
  }

  L.push("## Wealth & Advancement");
  L.push("");
  L.push(`**${RULES.currencyName()}:** ${fmt(play.cash)} · **Kismet:** ${play.kismet} available / ${play.kismet_earned} lifetime · **Boons:** ${econ.regularsAvail} regular, ${econ.majorsAvail} major available`);
  const spends = play.kismet_log.filter(entry => entry.delta < 0 || entry.delta === 0);
  if (spends.length) {
    L.push("");
    L.push("**Kismet spent on:**");
    spends.slice(0, 25).forEach(entry => L.push(`- ${entry.label}${entry.delta ? ` (${entry.delta})` : ""}`));
  }
  L.push("");

  if (play.notes && play.notes.trim()) {
    L.push("## Notes");
    L.push("");
    L.push(play.notes.trim());
    L.push("");
  }
  L.push(`*Exported from the Sinless Character Dossier · ${new Date().toISOString().slice(0, 10)}*`);
  // An exact copy of the build, base64'd inside an HTML comment: invisible in
  // Scabard and every markdown viewer, ~8KB, and it makes this file restorable
  // without guessing. Import reads it if it's there and falls back to reading
  // the prose above if it isn't. See static/md-import.js — the parser is
  // coupled to the format of everything above this line.
  if (typeof mdPayloadComment === "function") {
    L.push("");
    L.push(mdPayloadComment(CHAR));
  }
  return L.join("\n");
}
