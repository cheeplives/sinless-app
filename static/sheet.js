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

const HACKING_RATING_COST = 5000;    // per level; deck needs rating ≥ ½ MCP (min 1)
const HACKING_RATING_MAX = 6;
const SPELL_FORCE_MAX = 6;           // spells are learned/advanced to Force 6 at most

/* Weapon Type -> the skill you roll to use it (everything else is Firearms) */
const WEAPON_SKILL_BY_TYPE = {
  Melee: "Melee Weapons",
  Thrown: "Throwing Weapons",
  GrenadeLauncher: "Heavy Weapons",
  Heavy: "Heavy Weapons",
  Energy: "Energy Weapons",
};
/* The ±1 a skill's specialization contributes for one specific weapon. Thin
   wrapper so the Overview dice chip and the Gear tab roll hint agree. */
function specAdjustFor(skill, weaponName, weaponType) {
  const entry = (CHAR.skill_specializations || {})[skill];
  return RULES.weaponSpecAdjust(entry, skill, weaponName, weaponType, DATA.tables);
}

function weaponRoll(type, weaponName) {
  const skill = WEAPON_SKILL_BY_TYPE[type] || "Firearms";
  const s = CALC.skills[skill] || {};
  const pool = s.pool || "Finesse";
  // final already folds in group-fallback dice, so no "grp" notation needed
  const spec = specAdjustFor(skill, weaponName, type);
  const rated = s.final > 0;
  const rating = rated ? Math.max(0, s.final + spec.delta) : "untrained";
  // Name the specialty rather than just moving the number, so a rating that
  // differs from the Skills tab explains itself.
  const note = (rated && spec.delta > 0) ? ` (+1 ${spec.term})`
    : (rated && spec.delta < 0) ? ` (−1 outside ${spec.term})` : "";
  return `Roll ${pool} ${CALC.pools[pool]}d · ${skill} ${rating}${note}`;
}

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
function ensurePlay() {
  const d = {
    cash: 0, cash_rolled: false, starting_cash: 0, cash_log: [],
    lifestyles: [], lifestyles_seeded: false, armor_worn: null,
    kismet: 0, kismet_earned: 0, kismet_log: [],
    boons_spent: 0, major_boons_spent: 0,
    physical_damage: 0, stun_damage: 0, initiative: 0,
    pool_used: {},                        // pool name -> dice spent from the pool
    pool_boost: {},                       // pool name -> temporary bonus dice
    pool_kismet: {},                      // pool name -> permanent Kismet-die boons
    effects: [], modifiers: [], notes: "",
    attribute_advances: {}, skill_advances: {},
    zp_advances: 0, spell_force_advances: {},
    purchases: { gear: [], augments: [], amp_powers: [], spells: [], hacking_levels: 0 },
    decking: { active_deck: "", loaded: [] },
    rigging: { active_rig: "", units: {} },
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
  return CHAR.play;
}
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
function logCash(label, delta) {
  CHAR.play.cash += delta;
  CHAR.play.cash_log.unshift({ label, delta });
}

function chargenLifestyles() {
  return (CHAR.lifestyles && CHAR.lifestyles.length)
    ? CHAR.lifestyles
    : (CHAR.lifestyle && CHAR.lifestyle.name ? [CHAR.lifestyle] : []);
}

function seedLifestyles() {
  const play = CHAR.play;
  if (play.lifestyles_seeded) return;
  chargenLifestyles().forEach((ls, i) =>
    play.lifestyles.push({ name: ls.name, months: ls.months || 0, active: i === 0 }));
  play.lifestyles_seeded = true;
}

/* Merge chargen (prepaid) lifestyles into play at finalize: add any not already
 * present by name, so a lifestyle picked or changed in chargen carries over even
 * on a RE-finalize. Runs only at an explicit finalize (not on every sheet view),
 * so it never resurrects a lifestyle the player removed during play. */
function syncChargenLifestyles() {
  const play = CHAR.play;
  play.lifestyles = play.lifestyles || [];
  for (const ls of chargenLifestyles()) {
    if (!play.lifestyles.some(p => p.name === ls.name)) {
      play.lifestyles.push({ name: ls.name, months: ls.months || 0,
        active: play.lifestyles.length === 0 });
    }
  }
  play.lifestyles_seeded = true;
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
    + "  • Everything bought in play (gear, augments, powers, spells, Hacking levels)\n"
    + `  • ${RULES.currencyName()} beyond the original starting roll (back to ${fmt(play.starting_cash || 0)})\n`
    + "  • Damage, initiative, effects, modifiers, ledgers, and notes\n\n"
    + "The chargen build itself (attributes, skills, purchased gear) is untouched."))
    return;
  const keepRolled = play.cash_rolled;
  const keepStart = play.starting_cash
    || (play.cash_log.find(e => e.label.startsWith("Starting cash roll")) || {}).delta || 0;
  const rollEntry = play.cash_log.find(e => e.label.startsWith("Starting cash roll"));
  const wornSnapshot = play.armor_worn;
  const keepGhost = play.ghost_rating;   // rolled once at first finalize — never re-rolled
  CHAR.play = {};
  ensurePlay();
  CHAR.play.cash_rolled = keepRolled;
  CHAR.play.starting_cash = keepStart;
  CHAR.play.cash = keepStart;
  if (rollEntry) CHAR.play.cash_log = [rollEntry];
  if (keepGhost) CHAR.play.ghost_rating = keepGhost;
  if (Array.isArray(wornSnapshot)) {   // worn flags as they were at finalize
    CHAR.play.armor_worn = wornSnapshot;
    CHAR.armor.forEach((a, i) => { a.active = wornSnapshot[i] !== false; });
  }
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
// dice: {value, selected, rerolled}
const rollerState = { open: false, count: 6, dice: [], bonus: 0, mode: "free" };

function rollerRefresh() {
  const cur = $("#die-roller");
  if (cur) cur.replaceWith(rollerOverlay());
}

/* Initiative as shown on the sheet: Focus-pool dice + Reaction ("12d+8"). */
function sheetInitiative() {
  return CALC.initiative
    || { dice: CALC.pools.Focus, bonus: CALC.attributes.Reaction.final, notes: [] };
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
        Object.assign(st, { mode: "free", bonus: 0, dice: [] });
      }
      st.open = !st.open;
      rollerRefresh();
    },
  }, "⚄"));
  if (!st.open) return wrap;

  const successes = st.dice.filter(d => d.value >= 4).length;
  const selected = st.dice.filter(d => d.selected).length;
  const clampCount = n => Math.max(1, Math.min(ROLLER_MAX_DICE, n));
  const stepBtn = (delta, label) => el("button", {
    class: "sh-roller-step",
    onclick: () => { st.count = clampCount(st.count + delta); rollerRefresh(); },
  }, label);

  const isInit = st.mode === "initiative";
  const panel = el("div", { class: "sh-roller" },
    el("div", { class: "sh-roller-head" }, isInit ? "Initiative Roll" : "Die Roller",
      el("button", { class: "sh-roller-close", title: "Close",
        onclick: () => { st.open = false; rollerRefresh(); } }, "✕")),
    el("div", { class: "sh-roller-controls" },
      stepBtn(-1, "–"),
      el("span", { class: "sh-roller-count" },
        `${st.count}d6` + (st.bonus ? `+${st.bonus}` : "")),
      stepBtn(1, "+"),
      el("button", { class: "btn sh-roller-roll", onclick: () => {
        st.dice = Array.from({ length: st.count },
          () => ({ value: rollerD6(), selected: false, rerolled: false }));
        rollerApply();
        rollerRefresh();
      } }, "Roll")));

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
    panel.append(el("div", { class: "sh-roller-hint" },
      "4–6 = Success. Tap dice to mark for re-roll — each die re-rolls once."
      + (isInit ? " The total is saved to your Initiative." : "")));
  } else {
    panel.append(el("div", { class: "sh-roller-hint" },
      isInit
        ? `Roll ${st.count}d6 — every 4–6 is a Success, plus ${st.bonus} Reaction.`
        : `Roll ${st.count}d6 — every 4–6 is a Success.`));
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
  const descField = el("div", { class: "sh-desc" },
    el("textarea", { class: "sh-desc-input", placeholder: "Character description…",
      spellcheck: "true",
      oninput: e => { CHAR.description = e.target.value; schedulePlaySave(); } },
      CHAR.description || ""));

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
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.attributes) {
        alert("That file doesn't look like an exported Sinless character.");
        return;
      }
      sheetMenuOpen = false;
      const merged = RULES.mergeDefaults(parsed);
      if (merged.name) STORAGE.saveCharacter(merged);   // so it shows in the Load list
      await openCharacter(merged);                      // opens in its own tab
      if (typeof refreshLoadList === "function") refreshLoadList();
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
      STORAGE.saveCharacter(CHAR);
      if (typeof refreshLoadList === "function") refreshLoadList();
      saveBtn.textContent = "Saved ✓";
      setTimeout(() => { saveBtn.textContent = "Save"; }, 1200);
    } }, "Save") : null;
    const newBtn = el("button", { class: "btn sh-mi-plain", onclick: () => {
      sheetMenuOpen = false; newCharacterTab();
    } }, "New");

    // Group 2 — Import / Export.
    const importBtn = el("button", { class: "btn sh-mi-load", onclick: () => importInput.click() }, "Import JSON");
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
      [loadSel, saveBtn, newBtn],
      [importBtn, exportJsonBtn, exportMdBtn],
      [sharingBtn, sharedBtn, homebrewBtn],
      [backBtn, revertBtn, deleteBtn],
      [adminBtn, signOutBtn],
    ].map(g => g.filter(Boolean)).filter(g => g.length);

    const panel = el("div", { class: "sh-menu-panel", role: "menu" });
    groups.forEach((g, i) => {
      if (i > 0) panel.append(el("div", { class: "sh-menu-sep" }));
      g.forEach(b => panel.append(b));
    });
    panel.append(importInput);

    wrap.append(
      el("div", { class: "sh-menu-backdrop", onclick: () => { sheetMenuOpen = false; renderWorkspaceBar(); } }),
      panel);
  }
  return wrap;
}
async function backToChargen() {
  if (!confirm("Return to character generation?\n\nChargen budgets become editable again. "
    + "Play state (damage, Kismet, notes, advances, purchases) is kept and returns when you re-finalize."))
    return;
  CHAR.finalized = false;
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
function arrayMove(arr, i, dir, after = playChanged) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  after();
}

// Cyberguns are augments with a chosen gun; surface them as read-only weapons
// on the Overview loadout and the Gear weapons list.
function equippedCyberguns() {
  // Keep the source augment entry + its array so the Overview can drag-reorder
  // cyberguns (they're derived, so reordering acts on the underlying augments).
  const sources = [
    CHAR.augments,
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
  for (const g of [...CHAR.gear, ...((CHAR.play.purchases || {}).gear || [])]) {
    const row = DATA.tables.misc_gear.find(x => x.Item === g.name);
    if (row && (row.Class || "").startsWith("Ammo") && !seen.has(row.Item)) seen.set(row.Item, row);
  }
  return [...seen.values()];
}

/* Which ammo an entry is loaded with. An unset choice falls back to Standard --
   the plain rounds a gun is assumed to carry, and they have no effect, so the
   default changes no numbers. Falls through to nothing when the character owns
   no Standard, and when a previously chosen type has since been sold off. */
function ammoNameFor(entry) {
  const owned = ownedAmmoRows();
  if (owned.some(x => x.Item === entry.ammo)) return entry.ammo;
  if (entry.ammo === "") return "";                       // explicitly unloaded
  return owned.some(x => x.Item === "Standard") ? "Standard" : "";
}

/* The ammo an entry is loaded with, plus its parsed stat mods. */
function loadedAmmoFor(entry) {
  const none = { row: null, name: "", mods: RULES.ammoStatMods(""), notes: [] };
  const name = ammoNameFor(entry);
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
  for (const w of CHAR.weapons) {
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
function munitionPicker(entry, type) {
  if (["Melee", "Thrown", "Energy"].includes(type)) return "—";
  const launcher = type === "GrenadeLauncher";
  const owned = launcher ? ownedGrenadeRows() : ownedAmmoRows();
  const key = r => (launcher ? r.Weapon : r.Item);
  if (!owned.length)
    return el("span", { class: "sub" }, launcher ? "no grenades owned" : "none owned");
  const ro = !!(activeTabObj() && activeTabObj().readonly);
  const cur = launcher ? loadedGrenadeFor(entry).name : ammoNameFor(entry);
  if (ro) return el("span", { class: "sub" }, cur || "—");
  const label = r => launcher
    ? `${r.Weapon.replace(/\s*Grenade$/i, "")} — DMG ${r.Damage || "—"}`
    : (r.Effect ? `${r.Item} — ${r.Effect}` : r.Item);
  return el("select", { class: "sh-fire-sel",
    title: launcher ? "Chambered grenade" : "Loaded ammunition",
    onchange: e => { entry.ammo = e.target.value; playChanged(); } },
    el("option", { value: "" }, launcher ? "— empty —" : "— none —"),
    ...owned.map(r => el("option", { value: key(r), ...(key(r) === cur ? { selected: 1 } : {}) },
      label(r))));
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
function firingModeControls(w, r, calcRow, modes, mode, kataOffered = false) {
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
  wrap.append(
    el("button", { class: "btn small", disabled: dry ? "1" : null,
      title: dry ? `Not enough rounds loaded for ${mode} (needs ${cost})`
                 : `Fire ${mode} — spends ${cost} round${cost === 1 ? "" : "s"}`
                   + (kataOn ? " (includes the Gun-Kata bullet)" : ""),
      onclick: () => { w.loaded = Math.max(0, loaded - cost); playChanged(); } }, "Fire"),
    el("button", { class: "btn small", disabled: loaded >= maxAmmo ? "1" : null,
      title: "Reload to a full magazine",
      onclick: () => { w.loaded = maxAmmo; playChanged(); } }, "Reload"));
  return wrap;
}

function shOverview(body) {
  const play = CHAR.play;
  const econ = kismetEcon();

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
  const rawWound = -(Math.floor(play.physical_damage / 3) + Math.floor(play.stun_damage / 3));
  const woundNegated = !!CALC.combat.wound_penalty_negated;   // Pain Nullifier, Shibumi, …
  const woundDoubled = !!CALC.combat.wound_penalty_doubled;   // Reaction Enhancer bioware
  const wound = woundNegated ? 0 : rawWound * (woundDoubled ? 2 : 1);
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
    statLine("Simple actions", String(c.simple_actions)),
    ...exploitLines(c.exploit_actions),
    c.dodge_bonus ? statLine("Dodge bonus", `+${c.dodge_bonus}`, (c.dodge_sources || []).join(" · ")) : null,
    c.soak_bonus ? statLine("Soak bonus", `+${c.soak_bonus}`, (c.soak_sources || []).join(" · ")) : null,
    statLine("Carried weight", String(c.carried_weight)));
  const dodgeCard = el("div", { class: "card sh-card sh-counter" },
    el("h3", {}, "Dodge Dice"),
    el("div", { class: "big" }, String(play.dodge_dice || 0)),
    el("div", { class: "sub" },
      c.dodge_bonus ? `+ ${c.dodge_bonus} passive dodge bonus` : "Bonus dice gained in play (Full Defense, cover, …)"),
    miniCounter("Dodge dice", () => play.dodge_dice || 0, v => { play.dodge_dice = v; }, 0, 99));

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
    ...[poolCard, cond, maCard, infCard, initCard, dodgeCard, combatCard].filter(Boolean)));

  // Heritage / uplift special abilities (e.g. a Bat's Echolocation) — surfaced
  // here on the Overview, not just buried on the Notes tab.
  const heritageCard = heritageTraitsCard();
  if (heritageCard) body.append(heritageCard);

  // --- equipped weapons (+ mods) and worn armor, mirrored from the Gear tab
  const equippedWeapons = CHAR.weapons.filter(w => w.equipped !== false);
  const cyberguns = equippedCyberguns();
  const wornArmor = CHAR.armor.filter(a => a.active !== false);
  const grantedWeapons = CALC.combat.granted_weapons || [];
  const traitGear = CALC.combat.trait_gear || [];
  // Ammo owned (chargen gear + anything bought in play), merged by name so one
  // ammo type reads as a single stack of uses. Ordered as the tables list it.
  const ammoOnHand = (() => {
    const byName = new Map();
    for (const g of [...CHAR.gear, ...((CHAR.play.purchases || {}).gear || [])]) {
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
    const weaponSkillDice = (name, type, accuracy, bonuses = []) => {
      const skill = RULES.weaponSkillName(name, type);
      const s = skill && (CALC.skills || {})[skill];
      if (!s) return null;
      const acc = +accuracy || 0;
      // A specialization is +1 on what it covers and -1 on everything else the
      // skill rolls, so it resolves per weapon rather than as the flat -1/+1
      // pair the Skills tab shows.
      const spec = specAdjustFor(skill, name, type);
      // The bladed cyber implants roll Cybertech Combat, which is trained only —
      // with no dice in it the weapon can't be used at all, so say so rather than
      // showing an Accuracy-only dice count that implies you can swing it.
      const locked = s.trained_only && !(s.final > 0 || s.dice_bonus);
      if (locked)
        return el("b", { class: "wpn-dice locked",
          title: `${skill} is trained only — needs at least 1 die in the skill or its group` },
          "(trained only)");
      // Skill dice and bonus dice are kept apart because they behave
      // differently at the table. The specialization moves the SKILL rating;
      // Accuracy (mods already folded in by CALC) and the firing mode are
      // bonus, and every bonus source collapses into one number.
      const skillDice = Math.max(0, s.final + spec.delta);
      const extra = bonuses.reduce((n, b) => n + (+b.dice || 0), 0);
      const bonus = acc + extra;
      const why = [`${skill} ${s.final}`];
      if (spec.delta > 0) why.push(`+1 specialized in ${spec.term}`);
      if (spec.delta < 0) why.push(`−1 outside your specialty (${spec.term})`);
      why.push(`= ${skillDice} skill dice`);
      const bwhy = [];
      if (acc) bwhy.push(`Accuracy ${acc}`);
      for (const b of bonuses) if (+b.dice) bwhy.push(`${b.label} +${b.dice}`);
      return el("span", { class: "wpn-dice-set" },
        el("b", { class: "wpn-dice" + (spec.delta ? (spec.delta > 0 ? " spec-on" : " spec-off") : ""),
          title: why.join(" ") }, `(${skillDice}d`),
        bonus
          ? el("b", { class: "wpn-bonus", title: `Bonus dice: ${bwhy.join(" + ")}` },
              ` +${bonus}b`)
          : null,
        el("b", { class: "wpn-dice" }, ")"));
    };
    const loadout = el("div", { class: "card sh-card" }, el("h3", {}, "Loadout"));
    if (equippedWeapons.length || cyberguns.length) {
      const wt = el("table");
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
          // grenade launcher takes its Damage and Pen wholesale from the
          // chambered grenade -- its own Damage column just says "By Grenade".
          const baseAcc = calcRow.Accuracy ?? r.Accuracy ?? 0;
          const base = { acc: baseAcc, damage: calcRow.Damage ?? r.Damage ?? "—", pen: r.Pen || 0 };
          const isLauncher = r.Type === "GrenadeLauncher";
          // Melee, thrown and energy weapons load nothing, so they must not pick
          // up the default Standard round.
          const canLoad = !["Melee", "Thrown", "Energy"].includes(r.Type);
          const gren = isLauncher ? loadedGrenadeFor(w) : null;
          const ammo = (isLauncher || !canLoad)
            ? { row: null, name: "", notes: [] } : loadedAmmoFor(w);
          const munName = isLauncher ? gren.name : ammo.name;
          const munNotes = isLauncher ? gren.notes : ammo.notes;
          const shot = isLauncher
            ? (gren.row ? { acc: baseAcc, damage: gren.row.Damage || "—", pen: gren.row.Pen || 0 }
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
              weaponSkillDice(w.name, r.Type, shot.acc, bonuses),
              " · ",
              r.Type === "Melee" ? `Reach ${r.Reach || 0}` : statBit("Acc", "acc"),
              " · ", statBit("DMG", "damage"), " · ", statBit("Pen", "pen"),
              ` · Conceal ${r.Conceal || 0} · ZR ${r.ZR || 0} · Weight ${r.Weight || 0}`
              + ((calcRow.Ammo ?? r.Ammo) ? ` · Mag ${calcRow.Ammo ?? r.Ammo}` : "")
              + (r.Hardening ? ` · Hardening ${r.Hardening}` : "")
              + (r.Rarity && r.Rarity !== "-" ? ` · Rarity ${r.Rarity}` : ""),
              modNames.length
                ? el("div", { class: "sub wpn-mods" }, "Mods: " + modNames.join(" · ")) : null,
              munNotes.length
                ? el("div", { class: "sub wpn-ammo-note" }, `${munName}: ${munNotes.join(" · ")}`) : null),
            fire: el("td", { class: "sub" },
              modes.length ? firingModeControls(w, r, calcRow, modes, mode, kataOffered) : "—"),
            ammo: el("td", { class: "sub" }, munitionPicker(w, r.Type)),
          };
        },
      }));
      cyberguns.forEach((cg, idx) => items.push({
        ins: 1000 + idx, getOrder: () => cg.src.lo, setOrder: v => { cg.src.lo = v; },
        cells: () => {
          const g = cg.gun;
          // A cybergun loads ammo like any other firearm. The choice lives on
          // the source augment entry, since the gun row itself is shared data.
          const ammo = loadedAmmoFor(cg.src);
          const base = { acc: g.Acc, damage: g.Dmg, pen: g.Pen };
          const shot = RULES.applyAmmoStats(base, ammo.mods);
          const bit = (label, key) => el("span",
            (ammo.row && String(shot[key]) !== String(base[key]))
              ? { class: "wpn-ammo-mod", title: `${ammo.name} ammo` } : {},
            `${label} ${shot[key]}`);
          return {
            name: el("b", {}, cg.name + " (smart)"),
            stats: el("td", { class: "sub" },
              "Cybergun", weaponSkillDice(cg.name, "Cybergun", shot.acc, []),
              " · ", bit("Acc", "acc"), " · ", bit("DMG", "damage"), " · ", bit("Pen", "pen"),
              ` · Mag ${g.Ammo}`,
              el("div", { class: "sub wpn-mods" }, "Implanted — configured on the Augments tab"),
              ammo.notes.length
                ? el("div", { class: "sub wpn-ammo-note" }, `${ammo.name}: ${ammo.notes.join(" · ")}`) : null),
            // Firing mode is fixed by the implant; ammo is not.
            fire: el("td", { class: "sub" }, g.Modes || "—"),
            ammo: el("td", { class: "sub" }, munitionPicker(cg.src, "Cybergun")),
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
      const stowed = CHAR.weapons.filter(w => w.equipped === false);
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
    // Natural / implanted / power-granted melee weapons (Hand Razors, Spurs,
    // Fangs, Iron Fist, …) — auto-calculated Strength-based damage and Reach.
    if (grantedWeapons.length) {
      const gt = el("table");
      gt.append(el("tr", {}, el("th", {}, "Natural / cyber weapon"),
        el("th", {}, "Stats"), el("th", {}, "Source")));
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
          : weaponSkillDice(gw.name, "Natural", 0);
        gt.append(el("tr", {},
          el("td", {}, el("b", {}, gw.name)),
          gw.stats
            ? el("td", { class: "sub" }, gw.stats)
            : el("td", { class: "sub" }, gw.kind || "Melee", dice,
                ` · DMG ${gw.damage}` + (gw.note ? ` · ${gw.note}` : ` · Reach ${gw.reach}`)),
          el("td", { class: "sub" }, gw.source)));
      });
      loadout.append(gt);
    }
    // Heavy Torso / No Head free-mount gear — weapons (with stats) and extra
    // limbs, each noting the granting trait.
    if (traitGear.length) {
      const tt = el("table");
      tt.append(el("tr", {}, el("th", {}, "Trait-mounted"),
        el("th", {}, "Stats"), el("th", {}, "From trait")));
      traitGear.forEach(g => {
        const w = g.weapon;
        const stats = g.kind === "weapon" && w
          ? [`${w.Type || ""}`, weaponSkillDice(w.Weapon, w.Type, w.Accuracy),
             ` · Acc ${w.Accuracy || 0} · DMG ${w.Damage || "—"} · Pen ${w.Pen || 0}`
             + ` · Conceal ${w.Conceal || 0} · wt ${w.Weight || 0}`]
          : ["Extra limb (free mount)"];
        tt.append(el("tr", {},
          el("td", {}, el("b", {}, g.label)),
          el("td", { class: "sub" }, ...stats),
          el("td", { class: "sub" }, g.source)));
      });
      loadout.append(tt);
    }
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
          // view, so map back through CHAR.armor to reach the CALC row.
          const arow = (CALC.armor || [])[CHAR.armor.indexOf(a)] || {};
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
      loadout.append(el("div", { class: "sh-advrow", style: "border:0;padding:6px 0 0" },
        el("span", { class: "sub" }, `Total armor: ${CALC.combat.ballistic_armor}B / ${CALC.combat.impact_armor}I`)), at);
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
    el("td", { class: "num" }, el("b", {}, rating),
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
  CHAR.knowledge_skills ??= [];
  const kBudget = CALC.knowledge || { budget: 0, spent: 0, remaining: 0 };
  know.append(el("h4", { class: "sh-h4" }, "Knowledges"),
    el("p", { class: "hint", style: "margin:0 0 6px" },
      `${kBudget.remaining} / ${kBudget.budget} points left — 2 × Intelligence `
      + "(+1 per Knowledge Skillsoft), free-form, spendable any time."));
  const kt = el("table", { style: "max-width:560px" });
  CHAR.knowledge_skills.forEach((k, i) => {
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
        onclick: async () => { CHAR.knowledge_skills.splice(i, 1); await playChangedRecalc(); } }, "✕"))));
  });
  if (!CHAR.knowledge_skills.length)
    kt.append(el("tr", {}, el("td", { class: "sub", colspan: "3" }, "No knowledge skills yet.")));
  know.append(kt, el("div", { class: "add-row" },
    el("button", {
      class: "btn-add", disabled: kBudget.remaining < 1 ? "1" : null,
      onclick: async () => { CHAR.knowledge_skills.push({ name: "", points: 1 }); await playChangedRecalc(); },
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
function weaponModSlots(w, mult, weaponName) {
  const table = DATA.tables.weapon_mods;
  const order = ["Overbarrel", "Underbarrel", "Chassis"];
  const boxes = RULES.assignWeaponModSlots(w.mods || [], table).assigned;
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
        title: "Click to remove",
        onclick: () => {
          const idx = w.mods.indexOf(modName);
          if (idx >= 0) w.mods.splice(idx, 1);
          playChangedRecalc();
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
          const cost = Math.round((+(mr && mr.Cost) || 0) * mult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) {
            e.target.value = ""; return;
          }
          (w.mods = w.mods || []).push(name);
          logCash(`Fitted ${name} to ${weaponName}`, -cost);
          playChangedRecalc();
        },
      }, el("option", { value: "" }, `+ ${slot}…`),
        ...options.map(m => el("option", { value: m.Modification },
          `${m.Modification} (${fmt(Math.round((+m.Cost || 0) * mult))})`))));
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

function shUsesStepper(entry, onChange) {
  const val = el("span", { class: "sv" }, String(entry.qty || 0));
  const btn = (delta, label, title) => el("button", { class: "btn small", title,
    onclick: async () => {
      entry.qty = Math.max(0, (entry.qty || 0) + delta);
      val.textContent = String(entry.qty);
      await onChange();
    } }, label);
  return el("span", { class: "stepper" },
    btn(-1, "–", "Spend a use (no refund)"),
    val,
    btn(1, "+", "Add a use you already own — buy more in the Buy section below"));
}

/* Mounted-augment editor for host gear (Power Armor, Arwin Goggles, homebrew
   with a "Mount Types" column). Mounted augments are managed with the gear —
   they never appear on the Augments tab, their ZR is exempt from ZP, and
   their effects only apply while the host is worn / carried / equipped. */
function shMountEditor(host, hostRow, hostActive) {
  const cap = RULES.mountCapability(hostRow || {});
  if (!cap) return null;
  host.mounted ??= [];
  const mult = CALC.budget.gear_cost_multiplier || 1;
  const r2 = x => Math.round(x * 100) / 100;
  const copies = Math.max(1, +(host.qty || 1));   // armor entries have no qty
  const capacity = r2(cap.capacity * copies);
  const augRow = name => DATA.tables.augments.find(a => a.Name === name);
  const used = r2(host.mounted.reduce((sum, m) => {
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
        groups: mountBrowserGroups(cap, free, host.mounted, mult),
        afterAdd: () => playChangedRecalc(),
        onAdd: name => {
          const row = augRow(name) || {};
          const cost = Math.round((+row.Cost || 0) * mult);
          if (CHAR.play.cash < cost
              && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
            return;
          host.mounted.push({ name });
          logCash(`Mounted ${name} on ${host.name}`, -cost);
        },
      }) }, "+ Mount")));

  if (host.mounted.length) {
    wrap.append(el("div", {}, ...host.mounted.map((m, idx) => {
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
            m.alpha = !m.alpha;
            logCash(m.alpha ? `Upgraded ${m.name} (${host.name}) to α-cyber grade`
                            : `Reverted ${m.name} (${host.name}) from α-cyber grade`,
              m.alpha ? -alphaExtra : alphaExtra);
            await playChangedRecalc();
          } }, "α") : null,
        el("button", { class: "chip-btn", title: "Unmount (not refunded)",
          onclick: async () => {
            if (!confirm(`Remove ${m.name} from ${host.name}? Not refunded.`)) return;
            host.mounted.splice(idx, 1);
            await playChangedRecalc();
          } }, "✕"));
    })));
  }
  return wrap;
}

function shGear(body) {
  const play = CHAR.play;
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
  CHAR.weapons.filter(w => w.equipped !== false).forEach(w => {
    const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
    load += wtNum(r.Weight);
  });
  CHAR.armor.filter(a => a.active !== false).forEach(a => {
    const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
    load += wtNum(r.wt);
  });
  // Only what's actually on you counts against Strength -- gear left in a stash
  // carries no weight, which is the point of the per-item carried count.
  [...CHAR.gear, ...play.purchases.gear].forEach(g => {
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
      items: rows.map(r => ({ name: r.Weapon, cost: Math.round((+r.Cost || 0) * mult),
        sub: (r.Type === "Melee" ? `Reach ${r.Reach || 0}` : `Acc ${r.Accuracy || 0}`)
          + ` · DMG ${r.Type === "Melee" ? RULES.meleeDamage(r, CALC.attributes.Strength.final) : (r.Damage || "—")}`
          + ` · Pen ${r.Pen || 0} · Conceal ${r.Conceal || 0} · ZR ${r.ZR || 0} · wt ${r.Weight || 0}` })),
    }));
  const cyberguns = equippedCyberguns();
  if (CHAR.weapons.length || cyberguns.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Weapon"), el("th", {}, "Stats"),
      el("th", {}, "Equip"), el("th", {}, "")));
    CHAR.weapons.forEach((w, wi) => {
      const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
      const canMod = !["Melee", "Thrown", "GrenadeLauncher", "Heavy", "Energy"].includes(r.Type);
      const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
      t.append(el("tr", {},
        el("td", {},
          reorderHandle(() => arrayMove(CHAR.weapons, wi, -1), () => arrayMove(CHAR.weapons, wi, 1),
            wi > 0, wi < CHAR.weapons.length - 1),
          el("b", {}, w.name + ((calcRow.smart ?? w.smart) ? " (smart)" : "")),
          el("div", { class: "sub", style: "color:var(--manon)" }, weaponRoll(r.Type, w.name)),
          shMountEditor(w, r, w.equipped !== false)),
        el("td", { class: "sub" },
          `${r.Type || ""} · Acc ${calcRow.Accuracy ?? r.Accuracy ?? 0} · DMG ${calcRow.Damage ?? r.Damage ?? "—"} · ${r["Firing modes"] || "melee"} · Pen ${r.Pen || 0} · Conceal ${r.Conceal || 0} · ZR ${r.ZR || 0} · Weight ${r.Weight || 0}` +
          ((calcRow.Ammo ?? r.Ammo) ? ` · Ammo ${calcRow.Ammo ?? r.Ammo}` : "")),
        el("td", {}, el("input", { type: "checkbox", ...(w.equipped !== false ? { checked: 1 } : {}),
          onchange: async e => { w.equipped = e.target.checked; await playChangedRecalc(); } })),
        el("td", {}, el("button", { class: "row-del", title: "Sell / remove weapon",
          onclick: async () => {
            if (!confirm(`Remove ${w.name}?`)) return;
            CHAR.weapons.splice(wi, 1); await playChangedRecalc();
          } }, "✕"))));
      const upgBoxes = weaponUpgradeSlots(w, r, mult);
      if (canMod || upgBoxes.length) {
        const strip = canMod ? weaponModSlots(w, mult, w.name)
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
          `Cybergun · Acc ${g.Acc} · DMG ${g.Dmg} · ${g.Modes} · Pen ${g.Pen} · Ammo ${g.Ammo}`),
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
  if (CHAR.armor.length) {
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Armor"), el("th", { class: "num" }, "B / I"),
      el("th", {}, "Extras"), el("th", {}, "Worn"), el("th", {}, "")));
    CHAR.armor.forEach((a, ai) => {
      const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
      const baseCost = +r.Cost || 0;
      // Extras are cost multipliers; the marginal charge is base cost × (mult − 1).
      const extrasCell = r.Style === "Y"
        ? fittedCategoryEditor({
            id: `sh-aextras-${ai}-${a.name}`,
            items: a.extras || [],
            groups: [{ label: "Armor Extras", items: DATA.tables.armor_extras.map(x => ({
              name: x.Extra,
              cost: Math.round(baseCost * ((+x.Multiplier || 1) - 1) * armorMult),
              sub: `×${x.Multiplier}${x.Effects ? " · " + x.Effects : ""}`,
            })) }],
            onAdd: name => {
              const ex = DATA.tables.armor_extras.find(x => x.Extra === name) || {};
              const cost = Math.round(baseCost * ((+ex.Multiplier || 1) - 1) * armorMult);
              if (!overdrawOK(name, cost)) return;
              (a.extras = a.extras || []).push(name);
              logCash(`Added ${name} to ${a.name}`, -cost);
            },
            onRemove: index => { a.extras.splice(index, 1); },
            effectOf: name => (DATA.tables.armor_extras.find(x => x.Extra === name) || {}).Effects || "",
            rerender: renderSheet,
            afterAdd: () => playChangedRecalc(),
          })
        : "—";
      // Quality / Style and their gameplay effects (issue #18). CALC.armor is
      // built in CHAR.armor order, so index straight across.
      const arow = (CALC.armor || [])[ai] || {};
      const aeffects = arow.effects || [];
      t.append(el("tr", {},
        el("td", {},
          // CALC.armor is index-aligned to CHAR.armor, so a move has to recalc.
          reorderHandle(() => arrayMove(CHAR.armor, ai, -1, playChangedRecalc),
            () => arrayMove(CHAR.armor, ai, 1, playChangedRecalc),
            ai > 0, ai < CHAR.armor.length - 1),
          el("b", {}, a.name),
          el("div", { class: "sub" },
            ([arow.material, arow.style].filter(Boolean).join(" · ") || r.Slot || "") + ` · wt ${r.wt || 0}`),
          aeffects.length ? el("div", { class: "sub armor-effects" },
            aeffects.map(e => `${e.label}: ${e.text}`).join(" · ")) : null,
          shMountEditor(a, r, a.active !== false)),
        el("td", { class: "num" }, `${r.Ballistic || 0} / ${r.Impact || 0}`),
        el("td", { class: "sub" }, extrasCell),
        el("td", {}, el("input", { type: "checkbox", ...(a.active !== false ? { checked: 1 } : {}),
          onchange: async e => {
            a.active = e.target.checked;
            // Only one piece per armor slot may be worn at a time.
            if (a.active && r.Slot) {
              CHAR.armor.forEach(other => {
                if (other === a) return;
                const os = (DATA.tables.armor.find(x => x.Armor === other.name) || {}).Slot;
                if (os === r.Slot) other.active = false;
              });
            }
            await playChangedRecalc();
          } })),
        el("td", {}, el("button", { class: "row-del", title: "Sell / remove armor",
          onclick: async () => {
            if (!confirm(`Remove ${a.name}?`)) return;
            CHAR.armor.splice(ai, 1); await playChangedRecalc();
          } }, "✕"))));
    });
    armorCard.append(t);
  } else {
    armorCard.append(el("p", { class: "hint" }, "No armor owned — buy some in the Buy section below."));
  }
  body.append(armorCard);

  // ===== Gear list (chargen + bought in play) — remove buttons
  // (Augments moved to their own tab.)
  // Two backing stores rendered as one table (chargen kit, then bought-in-play).
  // Reordering stays inside an item's own array — moving across the boundary
  // would silently relabel a purchase — so the handles stop at each block's edge.
  const gearEntries = [
    ...CHAR.gear.map(g => ({ ref: g, inPlay: false, arr: CHAR.gear })),
    ...play.purchases.gear.map(g => ({ ref: g, inPlay: true, arr: play.purchases.gear }))];
  const gt = el("table");
  gt.append(el("tr", {}, el("th", {}, "Item"), el("th", { class: "num" }, "Qty"),
    el("th", { class: "num" }, "Weight"),
    el("th", {}, "Effect"), el("th", {}, "Carried"), el("th", {}, "")));
  let gearWeightCarried = 0, gearWeightOwned = 0;
  gearEntries.forEach(({ ref: g, inPlay, arr }) => {
    const r = DATA.tables.misc_gear.find(x => x.Item === g.name) || {};
    // Focus/Fetish/Spirit Bag links (chosen in chargen) now show — and stay
    // editable — on the sheet (issue #14). gearLinkSelect returns null otherwise.
    const ro = !!(activeTabObj() && activeTabObj().readonly);
    const linkSel = (!ro && typeof gearLinkSelect === "function")
      ? gearLinkSelect(g, playChangedRecalc) : null;
    const gi = arr.indexOf(g);
    // Ammo counts in uses rather than pieces: its Qty stepper is the rounds you
    // own, and the Carried spinner is how many of those are on you.
    const isAmmo = (r.Class || "").startsWith("Ammo");
    const owned = ownedQty(g);
    const unitWt = wtNum(r.Weight);
    const carried = carriedQty(g);
    gearWeightCarried += unitWt * carried;
    gearWeightOwned += unitWt * owned;
    const round1 = n => Math.round(n * 10) / 10;
    gt.append(el("tr", {},
      el("td", {},
        reorderHandle(() => arrayMove(arr, gi, -1), () => arrayMove(arr, gi, 1),
          gi > 0, gi < arr.length - 1),
        el("b", {}, g.name),
        inPlay ? el("span", { class: "sh-tag" }, "bought in play") : null,
        linkSel ? el("div", { class: "sub sh-gearlink" }, "Linked to ", linkSel)
          : (g.link ? el("div", { class: "sub" }, `Linked to ${g.link}`) : null),
        shMountEditor(g, r, g.carried !== false)),
      // Ammo is counted in uses, so it gets a live -/+ tracker for burning
      // rounds at the table (issue #21). It moves no cash -- buying more goes
      // through the Buy section below, which charges per use.
      el("td", { class: "num" }, (!ro && isAmmo)
        ? shUsesStepper(g, playChangedRecalc)
        : String(owned)),
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
        ? shCarriedStepper(g, playChangedRecalc)
        : el("input", { type: "checkbox", ...(g.carried !== false ? { checked: 1 } : {}),
            onchange: async e => {
              setCarriedQty(g, e.target.checked ? owned : 0);
              await playChangedRecalc();
            } })),
      el("td", {}, el("button", { class: "row-del", title: "Remove item",
        onclick: async () => {
          if (!confirm(`Remove ${g.name}?`)) return;
          const arr = inPlay ? CHAR.play.purchases.gear : CHAR.gear;
          const idx = arr.indexOf(g);
          if (idx >= 0) arr.splice(idx, 1);
          await playChangedRecalc();
        } }, "✕"))));
  });
  if (!gearEntries.length)
    gt.append(el("tr", {}, el("td", { class: "sub", colspan: "6" }, "No gear.")));
  else {
    const r1 = n => Math.round(n * 10) / 10;
    const stashed = r1(gearWeightOwned - gearWeightCarried);
    gt.append(el("tr", { class: "sh-gear-total" },
      el("td", { class: "sub" }, el("b", {}, "Gear weight")),
      el("td", {}, ""),
      el("td", { class: "num" }, el("b", {}, String(r1(gearWeightCarried)))),
      el("td", { class: "sub", colspan: "3" },
        `carried of ${r1(gearWeightOwned)} owned`
        + (stashed > 0 ? ` · ${stashed} left behind` : ""))));
  }
  body.append(el("div", { class: "card sh-card", id: "gear-gear" }, el("h3", {}, "Gear"), gt));

  // ===== Vehicles / rigs / decks owned (configured on their own tabs).
  // Drones and vehicles get their full Rigging-tab stat + attachment lines here
  // too, so the Gear tab is a complete inventory (issue #20).
  if (CHAR.rigs.length || CHAR.decks.length || CHAR.drones.length || CHAR.vehicles.length) {
    const vcard = el("div", { class: "card sh-card", id: "gear-vehicles" },
      el("h3", {}, "Vehicles, Rigs & Decks"),
      el("p", { class: "hint" }, "Bought, modified and removed on the Rigging and Decking tabs."));
    const unitEntries = [
      ...CHAR.drones.map(u => ({ table: "drones", u })),
      ...CHAR.vehicles.map(u => ({ table: "vehicles", u })),
    ];
    if (unitEntries.length) vcard.append(unitLoadoutTable(unitEntries));
    if (CHAR.rigs.length || CHAR.decks.length) {
      const vt = el("table");
      vt.append(el("tr", {}, el("th", {}, "Item"), el("th", {}, "Type")));
      const addRows = (list, label) => list.forEach(u =>
        vt.append(el("tr", {},
          el("td", {}, el("b", {}, u.label || u.name),
            (u.label && u.name) ? el("span", { class: "sub" }, ` (${u.name})`) : null),
          el("td", { class: "sub" }, label))));
      addRows(CHAR.rigs, "VCR");
      addRows(CHAR.decks, "Cyberdeck");
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
      const cost = Math.round((+r.Cost || 0) * mult);
      if (!overdrawOK(name, cost)) return;
      CHAR.weapons.push({ name, smart: Boolean(r["Integrated Smart"]),
        mods: [], equipped: true, qty: 1 });
      logCash(`Bought ${name}`, -cost);
    } }));
  buyBlock("Armor", categoryBrowser({ id: "sh-buy-armor", groups: armorBuyGroups,
    rerender: renderSheet, afterAdd: () => playChangedRecalc(),
    onAdd: name => {
      const r = DATA.tables.armor.find(x => x.Armor === name) || {};
      const cost = Math.round((+r.Cost || 0) * mult);
      if (!overdrawOK(name, cost)) return;
      CHAR.armor.push({ name, style: "", material: "", extras: [], active: true });
      logCash(`Bought ${name}`, -cost);
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
        el("td", { class: "num", style: entry.delta >= 0 ? "color:var(--ok)" : "color:var(--bad)" },
          (entry.delta >= 0 ? "+" : "") + fmt(entry.delta).replace("ㄓ-", "−ㄓ")))));
    body.append(el("div", { class: "card sh-card" }, el("h3", {}, "Activity"), t));
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

  const augEntries = [
    ...CHAR.augments.map(a => ({ ref: a, inPlay: false })),
    ...play.purchases.augments.map(a => ({ ref: a, inPlay: true }))];
  // Slotted Skillsofts grant their bonus; how many can be slotted at once is
  // capped by the number of Chipjacks installed.
  const ownedAugsAll = [...CHAR.augments, ...play.purchases.augments];
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
  const augmentRow = ({ ref: a, inPlay }) => {
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
      el("td", {}, el("button", { class: "row-del", title: "Remove (surgical removal — not refunded)",
        onclick: async () => {
          if (!confirm(`Remove ${a.name}? Surgical removal is not refunded.`)) return;
          const arr = inPlay ? CHAR.play.purchases.augments : CHAR.augments;
          const idx = arr.indexOf(a);
          if (idx >= 0) arr.splice(idx, 1);
          await playChangedRecalc();
        } }, "✕")));
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
          cost: Math.round((+r.Cost || 0)
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
  const hasHyperthyroid = [...CHAR.augments, ...((play.purchases && play.purchases.augments) || [])]
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
        miniCounter("Months", () => ls.months || 0, v => { ls.months = v; }),
        counterBtn(`+1 mo (${fmt(monthly)})`, () => {
          if (play.cash < monthly
              && !confirm(`A month of ${ls.name} costs ${fmt(monthly)} but you have ${fmt(play.cash)}. Overdraw?`))
            return;
          ls.months = (ls.months || 0) + 1;
          if (monthly) logCash(`Prepaid 1 month of ${ls.name} lifestyle`, -monthly);
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
  logCash(`Bought ${name}`, -cost);
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
  const owned = [...CHAR.augments, ...CHAR.play.purchases.augments];
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
  const cost = Math.round(r.Cost
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
  logCash(`Installed ${name}`, -cost);
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
            logCash(`Learned ${name} at Force ${force}`, -cost);
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
    const bondCount = s.bonds || 0;
    card.append(el("h4", { class: "sh-h4" }, `Bonds — ${bondCount} slot(s), track favors owed`));
    if (!bondCount) card.append(el("p", { class: "hint" }, "No spirit bonds purchased in chargen."));
    while (play.bond_slots.length < bondCount) play.bond_slots.push({ spirit: "", force: 0, favors: 0 });
    if (play.bond_slots.length > bondCount) play.bond_slots.length = bondCount;
    const bondTiles = el("div", { class: "sh-bond-tiles" });
    play.bond_slots.forEach((bond, bi) => {
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
  const decks = CHAR.decks;
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
  decks.forEach((d, di) => {
    const r = DATA.tables.decks.find(x => x.Name === d.name) || {};
    const isActive = d.name === dk.active_deck;
    d.mods = d.mods || [];
    const modEditor = fittedCategoryEditor({
      id: `sh-dmods-${di}-${d.name}`,
      items: d.mods,
      groups: modGroups(DATA.tables.deck_mods, "Deck Mod", null, "Deck Mods"),
      onAdd: name => {
        const mr = DATA.tables.deck_mods.find(m => m["Deck Mod"] === name) || {};
        const cost = Math.round((+mr.Cost || 0) * mult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        d.mods.push(name);
        logCash(`Fitted ${name} to ${d.name}`, -cost);
      },
      onRemove: index => { d.mods.splice(index, 1); },
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
        onclick: () => {
          if (!confirm(`Remove ${d.name}? Fitted mods are lost.`)) return;
          decks.splice(di, 1);
          if (dk.active_deck === d.name) { dk.active_deck = ""; dk.loaded = []; }
          playChangedRecalc();
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
        CHAR.decks.push({ name, mods: [] });
        logCash(`Bought ${name}`, -cost);
      } })));
  body.append(deckCard);

  // --- hacking program: deck needs rating ≥ ½ MCP (round down, min 1)
  const baseRating = CHAR.hacking_rating || 0;
  const boughtLevels = CHAR.play.purchases.hacking_levels || 0;
  const rating = baseRating + boughtLevels;
  const required = active ? Math.max(1, Math.floor(+active.MCP / 2)) : 0;
  const meets = !active || rating >= required;
  const levelCost = Math.round(HACKING_RATING_COST * mult);
  const hackBox = el("div", { class: "sh-hackbox" },
    el("div", { class: "sh-card-head" },
      el("h4", { class: "sh-h4", style: "margin:0" }, "Hacking Program"),
      el("span", { class: "chip" + (meets ? " ok" : " neg") },
        active ? `rating ${rating} / required ${required}` : `rating ${rating}`)),
    el("p", { class: "hint" },
      "The loaded Hacking program must be rated at least ½ the active deck's MCP (round down, min 1)"
      + (active ? ` — min ${required} for ${active.Name} (MCP ${active.MCP})` : "")
      + `, plus any levels bought on top. Each level costs ${fmt(levelCost)} (max ${HACKING_RATING_MAX}).`),
    statLine("Program rating", String(rating)
      + (boughtLevels ? ` (${baseRating} at chargen + ${boughtLevels} in play)` : "")),
    el("div", { class: "add-row" },
      el("button", {
        class: "btn-add", disabled: rating >= HACKING_RATING_MAX ? "1" : null,
        onclick: async () => {
          if (CHAR.play.cash < levelCost
              && !confirm(`A rating level costs ${fmt(levelCost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`))
            return;
          CHAR.play.purchases.hacking_levels = boughtLevels + 1;
          logCash(`Hacking program rating ${rating} → ${rating + 1}`, -levelCost);
          await playChangedRecalc();
        },
      }, rating >= HACKING_RATING_MAX ? "At max (6)" : `Buy +1 rating (${fmt(levelCost)})`)));

  const threads = active ? +active.Threads : 0;
  const progCard = el("div", { class: "card sh-card" },
    el("div", { class: "sh-card-head" },
      el("h3", {}, "Programs"),
      el("span", { class: "chip" + (dk.loaded.length > threads ? " neg" : "") },
        `Loaded ${dk.loaded.length} / ${threads}`)),
    hackBox);   // the Hacking program lives at the top of the Programs section
  // Programs whose I/O is N/A or No are never loaded onto threads — they run
  // without occupying a thread slot, so no Load button is shown for them.
  const loadable = io => io !== "N/A" && io !== "No";
  CHAR.programs.forEach((name, pi) => {
    const r = DATA.tables.programs.find(x => x.Name === name) || {};
    const io = r["I/O"] || "—";
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
        loadable(io)
          ? counterBtn(loaded ? "Unload" : "Load", () => {
              if (loaded) dk.loaded = dk.loaded.filter(n => n !== name);
              else if (dk.loaded.length >= threads) { alert("All threads are in use — unload something first."); return; }
              else dk.loaded.push(name);
              playChanged();
            }, loaded ? "" : "accent")
          : el("span", { class: "chip", title: `I/O ${io}: runs without occupying a thread` }, "no load"),
        el("button", { class: "row-del", title: "Remove program",
          onclick: () => {
            if (!confirm(`Remove program ${name}?`)) return;
            CHAR.programs.splice(pi, 1);
            dk.loaded = dk.loaded.filter(n => n !== name);
            playChangedRecalc();
          } }, "✕"))));
  });
  if (!CHAR.programs.length) progCard.append(el("p", { class: "hint" }, "No programs owned."));

  // buy new programs in play (grouped by Attack class, owned ones drop out)
  const ownedProg = new Set(CHAR.programs);
  const progByType = {};
  DATA.tables.programs.forEach(pr =>
    (progByType[pr.Attack || "Program"] ??= []).push(pr));
  const progGroups = Object.entries(progByType).sort(([a], [b]) => a.localeCompare(b))
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
        CHAR.programs.push(name);
        logCash(`Bought program ${name}`, -cost);
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
function removeUnitWeapon(u, wi) {
  u.weapons.splice(wi, 1);
  u.mods = (u.mods || []).reduce((acc, m) => {
    const idx = modWeaponIdx(m);
    if (idx === wi) return acc;
    acc.push(idx != null && idx > wi ? { ...m, weapon: idx - 1 } : m);
    return acc;
  }, []);
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
  for (const map of [rg.units, rg.linked, rg.unit_open]) {
    if (!map) continue;
    for (let n = removedAt; n < newLength; n++) {
      const next = map[`${table}:${n + 1}`];
      if (next === undefined) delete map[`${table}:${n}`];
      else map[`${table}:${n}`] = next;
    }
    delete map[`${table}:${newLength}`];
  }
}

/* Play-state key for a unit's slot in CHAR.play.rigging.units. Keyed by list
   position, matching the `${cfg.table}:${i}` convention the Rigging tab uses. */
function unitStateKey(table, unit) {
  const list = table === "drones" ? CHAR.drones : CHAR.vehicles;
  return `${table}:${(list || []).indexOf(unit)}`;
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
   tab (linked units) and the Gear tab (everything owned) so the two never drift
   -- issue #20 was the Gear tab showing only a name and a type. `entries` are
   {table, u} pairs, where table keys RIG_UNIT_CFG. */
function unitLoadoutTable(entries) {
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
      + (statMods.hardening ? ` · Hardening ${statMods.hardening}` : "")
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
    t.append(el("tr", {},
      el("td", {}, el("b", {}, u.label || u.name),
        u.label ? el("div", { class: "sub" }, u.name) : null,
        el("div", { class: "sub" }, cfg.title.replace(/s$/, ""))),
      el("td", { class: "sub" }, stats,
        dmgLine ? el("div", { class: "sh-unit-dmg" }, dmgLine) : null),
      el("td", {}, attachCell)));
  });
  return t;
}

function shRigging(body) {
  const rg = CHAR.play.rigging;
  rg.linked = rg.linked || {};
  // The small-heritage surcharge applies to vehicles (below, via unitBlock) but
  // not to VCRs/rigs or drones — those pay face value.
  const base = CALC.budget.gear_cost_multiplier || 1;
  const rigMult = RULES.surchargeFor("rig", base);
  if (CHAR.rigs.length && !CHAR.rigs.some(r => r.name === rg.active_rig))
    rg.active_rig = CHAR.rigs[0].name;

  const activeRig = CHAR.rigs.find(r => r.name === rg.active_rig);
  const linkLimit = activeRig ? RULES.rigStats(activeRig, DATA.tables).links : 0;
  const linkedCount = () => Object.values(rg.linked).filter(Boolean).length;
  // All "buy new unit" browsers collect here and render at the bottom.
  const rigBuySection = el("div", { class: "card sh-card", id: "rig-buy" },
    el("h3", {}, "Buy rigs, drones & vehicles"),
    el("p", { class: "hint" }, "New units are purchased here; configure owned ones above."));

  // --- VCRs
  const rigCard = el("div", { class: "card sh-card" }, el("h3", {}, "Vehicle Control Rigs"));
  CHAR.rigs.forEach((r, ri) => {
    const st = RULES.rigStats(r, DATA.tables);
    const isActive = r.name === rg.active_rig;
    r.mods = r.mods || [];
    const modEditor = fittedCategoryEditor({
      id: `sh-rmods-${ri}-${r.name}`,
      items: r.mods,
      groups: modGroups(DATA.tables.rig_mods, "Rig Mod", null, "Rig Mods"),
      onAdd: name => {
        const mr = DATA.tables.rig_mods.find(m => m["Rig Mod"] === name) || {};
        const cost = Math.round((+mr.Cost || 0) * rigMult);
        if (CHAR.play.cash < cost
            && !confirm(`${name} costs ${fmt(cost)} but you have ${fmt(CHAR.play.cash)}. Overdraw?`)) return;
        r.mods.push(name);
        logCash(`Fitted ${name} to ${r.name}`, -cost);
      },
      onRemove: index => { r.mods.splice(index, 1); },
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
        onclick: () => {
          if (!confirm(`Remove ${r.name}? Fitted mods are lost.`)) return;
          CHAR.rigs.splice(ri, 1);
          if (rg.active_rig === r.name) rg.active_rig = "";
          playChangedRecalc();
        } }, "✕")));
  });
  if (CHAR.rigs.length)
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
        CHAR.rigs.push({ name, mods: [] });
        logCash(`Bought ${name}`, -cost);
      } })));
  body.append(rigCard);

  // Active (VCR-linked) drones & vehicles summary — mirrors the Overview loadout.
  const activeUnits = [];
  [["drones", CHAR.drones], ["vehicles", CHAR.vehicles]].forEach(([table, list]) => {
    (list || []).forEach((u, i) => { if (rg.linked[`${table}:${i}`]) activeUnits.push({ table, u }); });
  });
  if (activeUnits.length) {
    body.append(el("div", { class: "card sh-card" },
      el("h3", {}, "Active drones & vehicles"), unitLoadoutTable(activeUnits)));
  }

  const unitBlock = (cfg, list, calcArr) => {
    // Only a vehicle's base chassis carries the small-heritage surcharge; fitted
    // weapons/mods (and everything on a drone) pay face value.
    const baseMult = cfg.table === "vehicles" ? RULES.surchargeFor("vehicle", base) : 1;
    const mult = 1;   // fitted weapons & mods — never surcharged
    const unitReadonly = !!(activeTabObj() && activeTabObj().readonly);
    const card = el("div", { class: "card sh-card" }, el("h3", {}, cfg.title));
    list.forEach((u, i) => {
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
            title: "Remove mod", onclick: () => { u.mods.splice(mi, 1); playChangedRecalc(); } },
            nm + " ✕");
        });
        const addWeaponMod = weaponScopedMods.length ? fittedCategoryEditor({
          id: `rig-wm-${key}-${wi}`, items: [],
          groups: modGroups(weaponScopedMods, mnc, null, "Weapon mods"),
          onAdd: name => { if (buyMod(name, wn)) u.mods.push({ name, weapon: wi }); },
          onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
        }) : null;
        return el("div", { class: "sub", style: "margin:4px 0" },
          el("span", { class: "chip", style: "cursor:pointer", title: "Remove weapon",
            onclick: () => removeUnitWeapon(u, wi) }, wn + " ✕"),
          ` DMG ${wr.Damage || "—"} · Acc ${wr.Accuracy || 0}`
          + (ammo ? ` · Ammo ${ammo}` : "") + (wr.Pen ? ` · Pen ${wr.Pen}` : ""),
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
          el("span", { class: "chip", style: "margin:2px 4px 0 0;cursor:pointer", title: "Remove mod",
            onclick: () => { u.mods.splice(mi, 1); playChangedRecalc(); } }, nm + " ✕"),
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
          u.weapons.push(name); logCash(`Mounted ${name} on ${u.label || u.name}`, -cost);
        },
        onRemove: () => {}, rerender: renderSheet, afterAdd: () => playChangedRecalc(),
      });
      // unit-level add-mod picker (unit-scoped mods only; weapon mods are added
      // per-weapon above)
      const addMod = fittedCategoryEditor({
        id: `rig-m-${key}`, items: [],
        groups: modGroups(unitScopedMods, mnc, null, `${cfg.nameKey} Mods`),
        onAdd: name => { if (buyMod(name, u.label || u.name)) u.mods.push(name); },
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
          } }),
        el("span", {}, isLinked ? "Linked to VCR" : "Link to VCR"));

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
        onclick: () => {
          if (!confirm(`Remove ${u.label || u.name}?`)) return;
          list.splice(i, 1);
          // Per-unit play state is keyed by list position, so removing a unit
          // has to shift every later unit's slot down — otherwise its damage
          // tracks (and the linked flag) land on the wrong vehicle.
          shiftUnitStateDown(cfg.table, i, list.length);
          playChangedRecalc();
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
                + (sm.hardening ? ` · Hardening ${sm.hardening}` : "")
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
          activeRig ? linkToggle : null),
        attachments));
    });
    if (!list.length) card.append(el("p", { class: "hint" }, `No ${cfg.title.toLowerCase()} owned.`));
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
          list.push({ name, weapons: [], mods: [] });
          logCash(`Bought ${name}`, -cost);
        } })));
  };
  unitBlock(RIG_UNIT_CFG.drones, CHAR.drones, CALC.drones);
  unitBlock(RIG_UNIT_CFG.vehicles, CHAR.vehicles, CALC.vehicles);
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
  return card;
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
  for (const pool of POOL_ORDER) {
    const trained = Object.entries(DATA.skills)
      .filter(([n, m]) => m.pool === pool && CALC.skills[n].final > 0)
      .sort((a, b) => CALC.skills[b[0]].final - CALC.skills[a[0]].final);
    if (!trained.length) continue;
    L.push(`**${pool} (${CALC.pools[pool]}d)**: `
      + trained.map(([n]) => `${n} ${CALC.skills[n].final}`).join(" · "));
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
  const knows = CHAR.knowledge_skills.filter(k => k.name);
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
    for (const [bi, bond] of (play.bond_slots || []).entries()) {
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

  const allAugments = [...CHAR.augments, ...play.purchases.augments];
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
  if (CHAR.weapons.length || cyberguns.length || grantedWeapons.length || traitGear.length) {
    L.push("## Weapons");
    L.push("");
    CHAR.weapons.forEach(w => {
      const r = DATA.tables.weapons.find(x => x.Weapon === w.name) || {};
      const calcRow = (CALC.weapons || []).find(x => x.Weapon === w.name) || {};
      const smart = (calcRow.smart ?? w.smart) ? " (smart)" : "";
      const isMelee = r.Type === "Melee";
      const ammo = calcRow.Ammo ?? r.Ammo;
      const stats = [`DMG ${calcRow.Damage ?? r.Damage ?? "—"}`,
                     isMelee ? `Reach ${r.Reach || 0}` : `Acc ${calcRow.Accuracy ?? r.Accuracy ?? 0}`,
                     `Pen ${r.Pen || 0}`,
                     `Conceal ${r.Conceal || 0}`,
                     (!isMelee && ammo) ? `Ammo ${ammo}` : null,
                     (!isMelee && r["Firing modes"]) ? r["Firing modes"] : null].filter(Boolean).join(" · ");
      L.push(`- **${w.name}**${smart} — ${stats}`
        + ((w.mods || []).length ? ` — mods: ${w.mods.join(", ")}` : ""));
    });
    cyberguns.forEach(cg => {
      const g = cg.gun;
      L.push(`- **${cg.name}** (smart) — DMG ${g.Dmg} · Acc ${g.Acc} · Pen ${g.Pen} · Ammo ${g.Ammo} · ${g.Modes}`);
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
  if (CHAR.armor.length) {
    L.push("## Armor");
    L.push("");
    CHAR.armor.forEach(a => {
      const r = DATA.tables.armor.find(x => x.Armor === a.name) || {};
      L.push(`- **${a.name}** — ${r.Ballistic || 0}B/${r.Impact || 0}I${a.active !== false ? " (worn)" : ""}`);
    });
    L.push("");
  }
  const allGear = [...CHAR.gear, ...play.purchases.gear];
  if (allGear.length || play.lifestyles.length) {
    L.push("## Gear");
    L.push("");
    allGear.forEach(g => L.push(`- ${g.name}${(g.qty || 1) > 1 ? ` ×${g.qty}` : ""}`));
    play.lifestyles.forEach(ls => {
      L.push(`- Lifestyle: ${ls.name} — ${ls.months || 0} month(s) prepaid${ls.active ? " **(current)**" : ""}`);
      if (ls.active && LIFESTYLE_EFFECTS[ls.name])
        L.push(`  - *Effect:* ${LIFESTYLE_EFFECTS[ls.name]}`);
    });
    L.push("");
  }
  if (CHAR.decks.length || CHAR.programs.length) {
    L.push("## Decking");
    L.push("");
    CHAR.decks.forEach(d => L.push(`- Deck: **${d.name}**${(d.mods || []).length ? ` (${d.mods.join(", ")})` : ""}`));
    if (CHAR.programs.length) L.push("- Programs: " + CHAR.programs.join(" · "));
    const hackingRating = (CHAR.hacking_rating || 0) + (play.purchases.hacking_levels || 0);
    if (hackingRating) L.push(`- Hacking program rating: ${hackingRating}`);
    L.push("");
  }
  if (CHAR.rigs.length || CHAR.drones.length || CHAR.vehicles.length) {
    L.push("## Rigging");
    L.push("");
    CHAR.rigs.forEach(r => L.push(`- Rig: **${r.name}**`));
    CHAR.drones.forEach(d => L.push(`- Drone: **${d.name}**${(d.weapons || []).length ? ` (${d.weapons.join(", ")})` : ""}`));
    CHAR.vehicles.forEach(v => L.push(`- Vehicle: **${v.name}**${(v.weapons || []).length ? ` (${v.weapons.join(", ")})` : ""}`));
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
  return L.join("\n");
}
