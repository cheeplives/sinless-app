/**
 * rules.js — Sinless character-generation engine.
 *
 * The canonical implementation of the chargen + play-mode rules. Pure
 * functions throughout: a character object goes in, a plain results object
 * comes out — the only shared mutable state is the `warnings`/`errors`
 * arrays each step appends to. The naming and structure mirror the original
 * Python engine this was ported from, but that Python project is no longer
 * maintained; this file is now the source of truth.
 *
 * Data comes from static/data.js (the DATA_BUNDLE global). Runs in the
 * browser (data.js loaded first) and under Node (require("./data.js")).
 *
 * Public API:
 *   RULES.calculate(character)   — full derived character sheet
 *   RULES.defaultCharacter()     — a blank character in canonical shape
 *   RULES.mergeDefaults(char)    — fill a loaded/imported character's shape
 */
"use strict";

const RULES = (() => {

const BUNDLE = (typeof DATA_BUNDLE !== "undefined")
  ? DATA_BUNDLE
  : require("./data.js");

// ============================================================== game constants
// The numeric knobs the engine reads; grouped by chargen step below.

const ATTRIBUTES = ["Strength", "Body", "Reaction", "Intelligence", "Willpower", "Charisma"];
const ATTRIBUTE_COLUMN = {  // Attribute name -> its column header in heritage_features.csv
  Strength: "STR", Body: "BOD", Reaction: "REA",
  Intelligence: "INT", Willpower: "WILL", Charisma: "CHA",
};

// Skill -> [pool it draws from, shared-training group fallback]
const SKILLS = {
  // Brawn pool
  "Athletics": ["Brawn", null],
  // NB: Martial Arts is NOT a normal skill — it's a per-style list on the
  // character (character.martial_arts = [{style, rank}]), each style an
  // independent skill at 2 pts/rank capped by Unarmed Combat. Handled in
  // scoreSkills / resolveMartialArts, not this map.
  "Cybertech Combat": ["Brawn", "close_combat"],
  "Melee Weapons": ["Brawn", "close_combat"],
  "Throwing Weapons": ["Brawn", "close_combat"],
  "Unarmed Combat": ["Brawn", "close_combat"],
  // Finesse pool
  "Archery": ["Finesse", null],
  "Articulated Movements": ["Finesse", null],
  "Firearms": ["Finesse", "ranged_combat"],
  "Gunnery": ["Finesse", "ranged_combat"],
  "Heavy Weapons": ["Finesse", "ranged_combat"],
  "Energy Weapons": ["Finesse", "ranged_combat"],
  // Focus pool
  "Artificing": ["Focus", null],
  "Biotech": ["Focus", null],
  "Computer: Programming": ["Focus", null],
  "Negotiation": ["Focus", null],
  "Observation": ["Focus", null],
  "Reconnaissance": ["Focus", null],
  "Shadow": ["Focus", null],
  "Engineering": ["Focus", null],
  "Computer: Hacking": ["Focus", "hacking"],
  "Locksmithing": ["Focus", "hacking"],
  "Drive": ["Focus", "vehicle"],
  "Fly": ["Focus", "vehicle"],
  // Resolve pool
  "Astral Senses": ["Resolve", null],
  "Channeling": ["Resolve", null],
  "Conjuring": ["Resolve", null],
  "Sorcery": ["Resolve", null],
  "Coercion": ["Resolve", null],
  "Fascination": ["Resolve", null],
  "Leadership": ["Resolve", null],
  "Subterfuge": ["Resolve", null],
  "Survival": ["Resolve", null],
};
const POOL_NAMES = ["Brawn", "Finesse", "Focus", "Resolve"];

const ETIQUETTES = ["Aristocratic", "Civic", "Corporate", "Criminal",
                    "Military", "Street", "Wasteland"];

const MARTIAL_ARTS_COST_MULTIPLIER = 2;

// --- priorities --------------------------------------------------------------
const PRIORITY_POOL_POINTS = 10;
const PRIORITY_MIN = 0, PRIORITY_MAX = 4;
const MAGIC_TYPE_BY_PRIORITY = { 4: "Archmage", 3: "Mage", 2: "Amp/Speaker", 1: "Hedge", 0: "Hedge" };
const MAGIC_TYPES_ALLOWED_BY_PRIORITY = {
  4: ["Amp", "Speaker", "Mage", "Archmage"],
  3: ["Amp", "Speaker", "Mage"],
  2: ["Amp", "Speaker"],
  1: ["Hedge"],
  0: ["Hedge"],
};
const HERITAGE_AVAILABILITY = [
  // [priority_low, priority_high, heritages unlocked in that range]
  [0, 0, ["Human", "Replicant"]],
  [1, 1, ["Synthetic", "Human"]],
  [2, 4, ["Blighted", "Green", "Uplift", "Synthetic", "Human"]],
];

// --- attributes --------------------------------------------------------------
const ATTRIBUTE_LEVEL_MIN = 1, ATTRIBUTE_LEVEL_MAX = 29;
const MANDATORY_ATTRIBUTE_REFUND = 6;
const ATTRIBUTE_MAX_BASELINE = 20;
const HYPERTHYROID_LIFESTYLE_SURCHARGE = 1.10;

const AUGMENTS_THAT_RAISE_MAX = ["Dermal Plating", "Muscle Replacement", "Wired Reflexes",
                                 "Synaptic Enhancers", "Boosted Reflexes",
                                 "Muscle Augmentation", "Bone Density"];

// --- skills ------------------------------------------------------------------
const SKILL_RANK_CAP = 6;
const EXPERTISE_SKILL_RANK_CAP = 8;
const EXPERTISE_SKILL_BONUS = 2;
const GROUP_FALLBACK_PENALTY = 2;
const GROUP_FALLBACK_MIN_TRAINED = 2;
const KNOWLEDGE_POINTS_PER_INTELLIGENCE = 2;
const ETIQUETTE_POINTS_PER_CHARISMA = 2;
const KNOWLEDGE_ETIQUETTE_RANK_CAP = 6;
const HEPHESTUS_ENGINEERING_BONUS = 2;
const CYCLOPEAN_RANGED_PENALTY = 2;
const RANGED_ATTACK_SKILLS = ["Archery", "Firearms", "Gunnery", "Throwing Weapons"];

// --- magic -------------------------------------------------------------------
const STARTING_FORCE_BY_MAGIC_TYPE = { Mage: 25, Archmage: 35 };
const SPELL_FORCE_MAX = 6;
const ARCHMAGE_SPIRIT_BIND_FORCE_COST = 15;
const SPEAKER_INFUSION_POINTS = 10;
const SPEAKER_RELATIONSHIP_POINTS = 11;
const AMP_COST_MULTIPLIER = 0.5;
const CHELONIAN_BALLISTIC_ARMOR = 2;
const CHELONIAN_IMPACT_ARMOR = 3;

// --- combat derived stats ------------------------------------------------------
const GHOST_RATING_DICE = "2d6";
const CONDITION_TRACK_BASE = 6;
const REPLICANT_CONDITION_BONUS = 6;
const REPLICANT_BONUS_ATTRIBUTE_POINTS = 6;
const REPLICANT_BONUS_SKILL_POINTS = 6;
const BASE_MOVE_METERS = 6;
const DEFAULT_SIMPLE_ACTIONS = 2;
const ADRENALINE_BOOST_SIMPLE_ACTIONS = 3;
const COMBAT_MASTERY_MELEE_EXPLOIT_BONUS = 2;
const IRON_FIST_BASE_DAMAGE = 6;   // Iron Fist amp: unarmed = ½STR + 6, Reach 0
const WIRED_REFLEXES_MELEE_EXPLOITS_BY_RANK = { 1: 1, 2: 2, 3: 2 };
// Decks/Rigs grant one hacking/rigging exploit action per processing core.
const CORE_EXPLOIT_COUNT = { Single: 1, Double: 2, Triple: 3, Quad: 4 };
// Mage/Archmage summoning spells that grant a control exploit for the summoned
// creature (one per spell known — the creature is directed with that action).
const SUMMON_CONTROL_SPELLS = ["Create Darkenbeast", "Summon Elemental", "Bound Servant"];
// A Speaker gets two control exploit actions per spirit slotted in a bond slot.
const SPEAKER_BOND_CONTROL_EXPLOITS = 2;
const COVERT_SYNTHSKIN_DODGE_BONUS = 1;
const PERFECT_SITUATIONAL_AWARENESS_BONUS = 3;   // +3d dodge AND soak (amp power)
const GYROMOUNT_RECOIL_BONUS = 2;
const PLATELET_DAMAGE_REDUCTION = 1;
// Augments granting a special sense or immunity (no numeric stat) — surfaced as
// a "senses & immunities" summary rather than folded into a derived number.
const SENSE_AUGMENTS = new Set([
  "Low-Light", "Thermographic", "Flare Compensation", "Augmented Eyesight",
  "Echolocation Positioning", "Dampener", "Gills", "Metabolic Stasis",
  "Broadcast Jammer", "Covert Synthskin", "Shimmerskin",
]);

/* ---- House rules (per-character, player-toggleable) ------------------------
 * A registry of optional rule variants the table can switch on. Each rule has
 * an id, a label, a set of options (value + label + help), and a default. Read
 * the active choice via houseRule(id) wherever a rule branches; the settings UI
 * (app.js) flips it with setHouseRule(). Choices live on each character
 * (character.house_rules) and are saved/synced with the character, so changing a
 * rule on one character never affects another. Every rule defaults to the
 * original behaviour so nothing changes until someone opts in. Add a rule by
 * appending a def here and branching on houseRule(<id>) at the relevant point in
 * the engine. */
const HOUSE_RULE_DEFS = [
  { id: "zr", label: "Zoetic Rating", default: "classic",
    options: [
      { value: "classic", label: "Classic",
        help: "Per-augment ZR; cyber eyes/ears absorb 0.5, each cyberlimb 1.0." },
      { value: "houserule", label: "ZR Casting Penalty",
        help: "Gear/weapon ZR doesn't touch ZP — it's −1d per full point on casting rolls (Channeling/Conjuring/Sorcery). Cyber ZR reduces ZP directly (may go negative; Synthetics exempt). At ZP ≤ 0 only Rituals work." },
    ] },
  { id: "priorities", label: "Priorities", default: "point",
    options: [
      { value: "classic", label: "Classic — A–E",
        help: "Assign the letters A, B, C, D, E (= priority 4, 3, 2, 1, 0) across the five categories — each letter used exactly once." },
      { value: "point", label: "Point-based",
        help: "Distribute 10 priority points, 0–4 per category; values may repeat." },
    ] },
  { id: "currency", label: "Currency name", default: "woolongs",
    options: [
      { value: "zuzus", label: "Classic — Zuzus",
        help: "The setting's money is called Zuzus." },
      { value: "woolongs", label: "House rule — Woolongs",
        help: "The setting's money is called Woolongs." },
    ] },
  { id: "ew", label: "Electronic Warfare", default: "houserule",
    options: [
      { value: "classic", label: "Classic — EW skill",
        help: "Adds a Computer: Electronic Warfare skill to the Computer group; the camera hack actions and the EW programs (Analysis Locus, Corrupt IFF, Acid Burn, De-Rez, Hypnotic Projection, Refraction Field, Targeted Disruption, Device Control) roll it." },
      { value: "houserule", label: "House rule — No EW skill",
        help: "No separate EW skill; those actions and programs use Computer: Hacking instead." },
    ] },
  { id: "engineering", label: "Engineering skills", default: "single",
    options: [
      // Classic listed first (house-rule dropdowns lead with Classic); the
      // default stays "single" so existing characters keep one Engineering skill.
      { value: "classic", label: "Classic (six skills)",
        help: "Engineering splits into a six-skill group — Aeronautics, Armory, Electronics, Industrial, Mechanical, Nautical. Like Ranged Weapons, an untrained member rolls the group's best −2." },
      { value: "single", label: "Single skill",
        help: "One Engineering skill covers every discipline." },
    ] },
];

// House rule: the single Engineering skill can split into a six-skill group.
const ENGINEERING_GROUP = "engineering";
const ENGINEERING_SPLIT_SKILLS = [
  "Engineering: Aeronautics", "Engineering: Armory", "Engineering: Electronics",
  "Engineering: Industrial", "Engineering: Mechanical", "Engineering: Nautical",
];

// Reshape the skill set to match the Engineering house rule. Mutates both SKILLS
// (the engine map) and the data bundle's skills map (the UI's source) so every
// consumer sees the same set. Idempotent — safe to run on each calculate().
// Character skill points for the inactive shape are left untouched, so toggling
// the rule back restores them.
function syncEngineeringSkills() {
  const classic = houseRule("engineering") === "classic";
  // The UI reads the bundle's top-level `skills` map (DATA.skills); loadData()
  // only exposes BUNDLE.tables, so mutate BUNDLE.skills directly here.
  const dskills = (BUNDLE.skills = BUNDLE.skills || {});
  if (classic) {
    delete SKILLS["Engineering"]; delete dskills["Engineering"];
    for (const name of ENGINEERING_SPLIT_SKILLS) {
      SKILLS[name] = ["Focus", ENGINEERING_GROUP];
      dskills[name] = { pool: "Focus", group: ENGINEERING_GROUP };
    }
  } else {
    for (const name of ENGINEERING_SPLIT_SKILLS) { delete SKILLS[name]; delete dskills[name]; }
    SKILLS["Engineering"] = ["Focus", null];
    dskills["Engineering"] = { pool: "Focus" };
  }
}

// House rule: the "Classic" Electronic Warfare rule adds a dedicated
// Computer: Electronic Warfare skill to the Computer (hacking) group. Same
// idempotent SKILLS + BUNDLE.skills reshaping as syncEngineeringSkills; points
// for the inactive shape are left untouched so toggling back restores them.
const EW_SKILL = "Computer: Electronic Warfare";
function syncEWSkill() {
  const classic = houseRule("ew") === "classic";
  const dskills = (BUNDLE.skills = BUNDLE.skills || {});
  if (classic) {
    SKILLS[EW_SKILL] = ["Focus", "hacking"];
    dskills[EW_SKILL] = { pool: "Focus", group: "hacking" };
  } else {
    delete SKILLS[EW_SKILL];
    delete dskills[EW_SKILL];
  }
}
// House rules are PER CHARACTER, stored on `character.house_rules`. The engine
// reads the active character's choices via houseRule() (activeHouseRules is
// pointed at that character's rules at the top of calculate()); the UI flips one
// with setHouseRule() and then persists the character. Changing a rule on one
// character never affects another.
// Legacy: earlier builds kept a single GLOBAL pref in localStorage. Read it once
// to seed characters that predate per-character rules, so their behaviour carries
// over unchanged on first load.
const LEGACY_HOUSE_RULES = (() => {
  try {
    if (typeof localStorage !== "undefined") {
      const saved = JSON.parse(localStorage.getItem("sinless:houserules") || "null");
      if (saved && typeof saved === "object") return saved;
    }
  } catch { /* blocked/absent localStorage */ }
  return null;
})();
const legacyOrDefault = def =>
  (LEGACY_HOUSE_RULES && def.options.some(o => o.value === LEGACY_HOUSE_RULES[def.id]))
    ? LEGACY_HOUSE_RULES[def.id] : def.default;
function defaultHouseRules() {
  const hr = {};
  for (const def of HOUSE_RULE_DEFS) hr[def.id] = legacyOrDefault(def);
  return hr;
}
// Repair/seed a character's house_rules IN PLACE (invalid or missing values fall
// back to the legacy global, then the rule's default) and return that same object
// so the UI's setHouseRule mutations land on the character.
function normalizeHouseRules(character) {
  const hr = character.house_rules || (character.house_rules = {});
  for (const def of HOUSE_RULE_DEFS)
    if (!def.options.some(o => o.value === hr[def.id])) hr[def.id] = legacyOrDefault(def);
  return hr;
}
let activeHouseRules = null;
function houseRule(id) {
  return (activeHouseRules && activeHouseRules[id])
    ?? (HOUSE_RULE_DEFS.find(d => d.id === id) || {}).default;
}
function setHouseRule(id, value) {
  const def = HOUSE_RULE_DEFS.find(d => d.id === id);
  if (!def || !def.options.some(o => o.value === value)) return;
  if (activeHouseRules) activeHouseRules[id] = value;   // written onto the active character
}
// The setting's money name, per the "currency" house rule. Reads the active
// character's choice (activeHouseRules is pointed at it during calculate(), so
// render code that runs after recalc sees the right value).
function currencyName() {
  return houseRule("currency") === "zuzus" ? "Zuzus" : "Woolongs";
}

// Programs (any rating) that key off Electronic Warfare under the Classic EW
// rule, and Computer: Hacking otherwise. Matched by base name (rating stripped).
const EW_PROGRAM_BASES = new Set([
  "Analysis Locus", "Corrupt IFF", "Acid Burn", "De-Rez",
  "Hypnotic Projection", "Refraction Field", "Targeted Disruption", "Device Control",
]);
function isEWProgram(name) {
  return EW_PROGRAM_BASES.has(String(name || "").replace(/\s+\d+$/, "").trim());
}
// The skill an EW program rolls, per the EW house rule; null for non-EW programs.
function programSkill(name) {
  if (!isEWProgram(name)) return null;
  return houseRule("ew") === "classic" ? EW_SKILL : "Computer: Hacking";
}
// The label for a hack-action's Skill cell: "EW" stays "EW" under Classic but
// reads "Hacking" when there's no EW skill; everything else is unchanged.
function hackActionSkill(skillCode) {
  if (skillCode === "EW") return houseRule("ew") === "classic" ? "EW" : "Hacking";
  return skillCode;
}
// NB: the cyber ZR *value* (raw minus eyes/ears/limb absorption) is the same
// under both ZR house rules; only how that ZR is *applied* differs — see the
// zpRemaining / casting-penalty branches in calculate() gated on houseRule("zr").
const SOUND_FILTER_OBSERVATION_BONUS = 1;
const MOVEMENT_ENHANCEMENT_METERS_PER_RATING = 2;

// --- gear & money --------------------------------------------------------------
const SMART_WEAPON_COST_MULTIPLIER = 2;
const EXTRA_LIMB_ARMOR_COST_MULTIPLIER = 1.5;   // Extra Arm / Extra Leg: +50% armor
const HACKING_RATING_COST = 5000;
const HACKING_RATING_MAX = 6;

// The small-heritage gear surcharge (Small Uplifts and the Green "Smol" bane
// carry GearCostMultiplier 1.4) only applies to physical kit a small body must
// be fitted for: Weapons, Armor, Vehicles, and cybertechtronic Augments.
// Bioware (grown to fit), Drones, Rigs, Decks/Programs, misc Gear, and
// Lifestyle pay face value. Both the engine and the play-mode buy screens read
// this through surchargeFor() so the two never disagree.
const SURCHARGED_KINDS = new Set(["weapon", "armor", "vehicle", "cyberware"]);
function surchargeFor(kind, baseMultiplier) {
  return SURCHARGED_KINDS.has(kind) ? (baseMultiplier || 1) : 1;
}

// ============================================================== data access
function loadData() {
  return BUNDLE.tables;
}

/** Python int(): truncate toward zero. */
const toInt = v => Math.trunc(v);
/** Python round(x, 2), close enough for money values. */
const round2 = v => Math.round(v * 100) / 100;

function asNumber(value, dflt = 0) {
  // Parse a data-table cell to a number: strip thousands commas, else `dflt`.
  if (value === null || value === undefined || typeof value === "boolean") return dflt;
  const s = String(value).replace(/,/g, "").trim();
  if (s === "") return dflt;
  const n = Number(s);
  return Number.isNaN(n) ? dflt : n;
}

/* Find a data-table row by its key column. Returns the FIRST match (weapon_mods
 * has intentional same-name rows per Slot, so name-only lookups there resolve to
 * the Overbarrel variant) or null. Which column keys which table is catalogued in
 * docs/DATA.md; tools/check_data.py verifies the literal call sites below stay in
 * sync with HOMEBREW_CONFIG and the promoter's NAME_KEYS. Call sites that pass the
 * table or column through a variable are invisible to that check. */
function findRow(rows, column, value) {
  const target = String(value || "").trim();
  for (const row of rows) {
    if (String(row[column] ?? "").trim() === target) return row;
  }
  return null;
}

const sumBy = (items, fn) => items.reduce((total, item) => total + fn(item), 0);
const maxOf = (values, dflt) => values.length ? Math.max(...values) : dflt;

// ============================================================== character shape
function defaultCharacter() {
  const attributes = {};
  for (const name of ATTRIBUTES) attributes[name] = 1;
  return {
    name: "",
    player: "",
    description: "",
    notes: "",
    house_rules: defaultHouseRules(),   // per-character optional rule variants
    priorities: { heritage: 0, magic: 0, attributes: 0, skills: 0, resources: 0 },
    heritage: {
      type: "Human",
      uplift_type: "",
      features: [],
      blessing_plus3: "",
      blessing_plus1: "",
      specialization_pool: "",
      heavy_torso_mounts: ["", ""],   // Heavy Torso: up to 2 free 1-wt mounts
      no_head_mount: "",              // No Head: one free 1-wt weapon mount
      snake_attack: "bite",           // Snake uplift: "bite" or "spit" (locked after chargen)
    },
    attributes,
    cha_pool_choice: "Brawn",
    skills: {},
    skill_specializations: {},
    ritual_skills: {},
    knowledge_skills: [],
    etiquettes: {},
    martial_arts: [],   // [{style, rank}] — each an independent Martial Arts skill
    magic: {
      chosen_type: "Amp",
      school: "",
      spells: [],
      amp_powers: [],
      archmage_bind: false,
    },
    speaker: {
      relationships: [],
      bonds: 0,
      infusions: [],
    },
    augments: [],
    weapons: [],
    armor: [],
    decks: [],
    programs: [],
    hacking_rating: 0,
    rigs: [],
    drones: [],
    vehicles: [],
    gear: [],
    lifestyle: { name: "", months: 0 },   // no default lifestyle — must be chosen in chargen
    lifestyles: [],
    finalized: false,
    play: {
      cash: 0,
      cash_rolled: false,
      starting_cash: 0,
      cash_log: [],
      lifestyles: [],
      lifestyles_seeded: false,
      kismet: 0,
      kismet_earned: 0,
      kismet_log: [],
      boons_spent: 0,
      major_boons_spent: 0,
      physical_damage: 0,
      stun_damage: 0,
      initiative: 0,
      dodge_dice: 0,
      replicant_lifespan_months: null,   // Replicant only: (1d6+1)×12, rolled once
      pool_used: {},
      effects: [],
      modifiers: [],
      notes: "",
      attribute_advances: {},
      skill_advances: {},
      martial_art_advances: {},   // { style: +ranks } bought in play
      ritual_advances: {},
      zp_advances: 0,
      spell_force_advances: {},
      purchases: {
        gear: [],
        augments: [],
        amp_powers: [],
        spells: [],
        hacking_levels: 0,
      },
      decking: { active_deck: "", loaded: [] },
      rigging: { active_rig: "", units: {} },
    },
  };
}

function mergeDefaults(character) {
  const defaults = defaultCharacter();
  const isPlainObject = v => v && typeof v === "object" && !Array.isArray(v);

  const fill = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (!(key in target)) target[key] = value;
      else if (isPlainObject(value)) {
        // Default expects a keyed object here. If the stored value isn't a
        // plain object (e.g. a legacy character whose skill_specializations was
        // persisted as []), reset it to the default: an array silently drops
        // any named props on JSON.stringify, so writes to it never save.
        if (isPlainObject(target[key])) fill(target[key], value);
        else target[key] = value;
      }
    }
  };

  fill(character, defaults);

  // Migrate the legacy single martial art (character.martial_art + the old
  // "Martial Arts" skill rank) into the per-style list. Idempotent: once the
  // list is populated and the legacy fields cleared, later runs are no-ops.
  if (!Array.isArray(character.martial_arts)) character.martial_arts = [];
  if (character.martial_arts.length === 0 && character.martial_art) {
    const rank = Math.max(0, toInt(asNumber((character.skills || {})["Martial Arts"])));
    character.martial_arts.push({ style: character.martial_art, rank });
  }
  if (character.skills && "Martial Arts" in character.skills) delete character.skills["Martial Arts"];
  delete character.martial_art;
  return character;
}

// ============================================================== step 1: priorities
function resolvePriorities(character, data, warnings, errors) {
  const prioritySpend = {};
  for (const [category, value] of Object.entries(character.priorities)) {
    prioritySpend[category] = Math.max(PRIORITY_MIN,
      Math.min(PRIORITY_MAX, toInt(asNumber(value))));
  }
  const pointsRemaining = PRIORITY_POOL_POINTS
    - Object.values(prioritySpend).reduce((a, b) => a + b, 0);
  // Classic priorities are a bijection: the five categories take the letters
  // A–E (= 4,3,2,1,0) once each. Any permutation of 0–4 sums to 10, so the
  // point pool is auto-satisfied; the added rule is that no value repeats.
  if (houseRule("priorities") === "classic") {
    const values = Object.values(prioritySpend);
    if (new Set(values).size !== values.length)
      errors.push("Classic priorities: assign each letter A–E exactly once (no repeats).");
  } else if (pointsRemaining < 0) {
    errors.push(`Priorities overspent by ${-pointsRemaining} point(s).`);
  }

  const priorityRowByLevel = {};
  for (const row of data.priorities) priorityRowByLevel[toInt(Number(row.Priority))] = row;
  const magicPriorityRow = priorityRowByLevel[prioritySpend.magic];
  const startingAttributePoints = toInt(asNumber(
    priorityRowByLevel[prioritySpend.attributes].AttributePoints));
  const startingSkillPoints = toInt(asNumber(
    priorityRowByLevel[prioritySpend.skills].SkillPoints));
  const startingCash = toInt(asNumber(
    priorityRowByLevel[prioritySpend.resources].Cash));

  const allowedMagicTypes = MAGIC_TYPES_ALLOWED_BY_PRIORITY[prioritySpend.magic];
  let magicType = character.magic.chosen_type || allowedMagicTypes[allowedMagicTypes.length - 1];
  if (!allowedMagicTypes.includes(magicType)) {
    magicType = allowedMagicTypes[allowedMagicTypes.length - 1];
  }

  const heritagePriority = prioritySpend.heritage;
  let allowedHeritages = ["Human"];
  for (const [lo, hi, heritages] of HERITAGE_AVAILABILITY) {
    if (lo <= heritagePriority && heritagePriority <= hi) { allowedHeritages = heritages; break; }
  }
  const chosenHeritageType = character.heritage.type;
  if (!allowedHeritages.includes(chosenHeritageType)) {
    errors.push(
      `${chosenHeritageType} requires a higher Heritage priority `
      + `(available at priority ${heritagePriority}: ${allowedHeritages.join(", ")}).`);
  }

  return {
    values: prioritySpend,
    remaining: pointsRemaining,
    magic_type: magicType,
    magic_priority_label: magicPriorityRow.Magic,
    starting_attr_pts: startingAttributePoints,
    starting_skill_pts: startingSkillPoints,
    starting_cash: startingCash,
    allowed_heritages: allowedHeritages,
  };
}

// ============================================================== step 2: heritage
function heritageTraitRows(character, data) {
  const heritage = character.heritage;
  const traitsByName = {};
  for (const row of data.heritage_features) traitsByName[row.Name] = row;
  const rows = [];
  if (heritage.type === "Uplift" && heritage.uplift_type) {
    const upliftRow = traitsByName[heritage.uplift_type];
    if (upliftRow) rows.push(upliftRow);
  }
  for (const featureName of heritage.features || []) {
    const row = traitsByName[featureName];
    if (row) rows.push(row);
  }
  return rows;
}

function applyHeritage(character, data, warnings, errors) {
  const heritage = character.heritage;
  const heritageType = heritage.type;
  const traits = heritageTraitRows(character, data);

  const sumColumn = column => sumBy(traits, row => asNumber(row[column]));

  const attributePointModifier = toInt(sumColumn("Modifier"));

  const attributeAdjustment = {};
  const attributeMaxAdjustment = {};

  // Initialize both adjustment objects
  for (const [name, column] of Object.entries(ATTRIBUTE_COLUMN)) {
    attributeAdjustment[name] = toInt(sumColumn(column));
    attributeMaxAdjustment[name] = 0;
  }

  // Move an attribute's current adjustment into the max-only bucket: it
  // raises/lowers the maximum but not the starting value. Accumulates so
  // multiple sources on the same attribute compose instead of clobbering.
  const moveToMaxOnly = name => {
    attributeMaxAdjustment[name] += attributeAdjustment[name];
    attributeAdjustment[name] = 0;
  };

  // Small Uplifts: STR and BOD reductions apply to the maximum only.
  const isSmallUplift = traits.some(row => row.SmallUplift === "true" || row.SmallUplift === true);
  if (isSmallUplift) {
    moveToMaxOnly("Strength");
    moveToMaxOnly("Body");
  }

  // Any heritage trait may name attributes whose modifier is max-only.
  for (const trait of traits) {
    if (!trait.MaxOnlyAttributes) continue;
    for (const raw of trait.MaxOnlyAttributes.split(",")) {
      const attrName = raw.trim();
      const fullName = attrName.charAt(0).toUpperCase() + attrName.slice(1).toLowerCase();
      if (ATTRIBUTES.includes(fullName)) moveToMaxOnly(fullName);
    }
  }

  if (traits.some(row => row.Name === "Nature's Blessing")) {
    const plus3 = heritage.blessing_plus3;
    if (ATTRIBUTES.includes(plus3)) attributeAdjustment[plus3] += 3;
    else warnings.push("Nature's Blessing: choose the +3 attribute.");
    const plus1 = heritage.blessing_plus1;
    if (ATTRIBUTES.includes(plus1)) attributeAdjustment[plus1] += 1;
    else warnings.push("Nature's Blessing: choose the +1 attribute.");
  }

  const traitCategories = traits.map(row => row.Category);
  validateBoonBaneCounts(heritageType, traitCategories, warnings, errors);

  if (heritageType === "Synthetic") {
    const traitNames = new Set(traits.map(row => row.Name));
    if (traitNames.has("Durable") && (traitNames.has("Arcano-Manon Interface Matrix")
                                      || traitNames.has("Specialization"))) {
      errors.push("Cannot have Durable with these Mods "
                  + "(Arcano-Manon Interface Matrix / Specialization).");
    }
  }

  let specializationPool = "";
  if (traits.some(row => row.Name === "Specialization")) {
    specializationPool = heritage.specialization_pool || "";
  }

  const heritageRow = findRow(data.heritages, "Name", heritageType);
  const baseZoeticPotential = toInt(asNumber((heritageRow || {}).ZP, 6));

  // Calculate gear cost multiplier (Small Uplifts get 40% increase)
  const smallUpliftMult = traits.reduce((max, row) => Math.max(max, asNumber(row.GearCostMultiplier, 1.0)), 1.0);
  const gearCostMult = smallUpliftMult;

  // Extra limbs (Extra Arm / Extra Leg) need custom-fitted armor: each such
  // trait adds +50% to ARMOR cost only (other gear is unaffected). Additive per
  // limb, and multiplies on top of any small-heritage armor surcharge.
  const extraLimbCount = traits.filter(row =>
    row.Name === "Extra Arm" || row.Name === "Extra Leg").length;
  const armorCostMult = 1 + (EXTRA_LIMB_ARMOR_COST_MULTIPLIER - 1) * extraLimbCount;

  // Heavy Torso / No Head free 1-weight mounts: resolve the player's picks into
  // granted gear (all free). Each pick is "Cyberarm"/"Cyberleg" (an extra limb)
  // or a weapon name. Ignored unless the granting trait is actually selected.
  const traitGear = [];
  const hasTrait = n => traits.some(row => row.Name === n);
  if (hasTrait("Heavy Torso")) {
    for (const choice of (heritage.heavy_torso_mounts || [])) {
      if (!choice) continue;
      if (choice === "Cyberarm" || choice === "Cyberleg")
        traitGear.push({ source: "Heavy Torso", kind: "limb", label: choice });
      else {
        const w = findRow(data.weapons, "Weapon", choice);
        if (w) traitGear.push({ source: "Heavy Torso", kind: "weapon", label: choice, weapon: w });
      }
    }
  }
  if (hasTrait("No Head") && heritage.no_head_mount) {
    const w = findRow(data.weapons, "Weapon", heritage.no_head_mount);
    if (w) traitGear.push({ source: "No Head", kind: "weapon", label: heritage.no_head_mount, weapon: w });
  }

  return {
    type: heritageType,
    traits,
    trait_gear: traitGear,
    attribute_adjustment: attributeAdjustment,
    attribute_max_adjustment: attributeMaxAdjustment,
    uplift_attribute_point_modifier: attributePointModifier,
    specialization_pool: specializationPool,
    zoetic_potential: baseZoeticPotential + toInt(sumColumn("ZP")),
    soak_bonus: toInt(sumColumn("Soak")),
    move_bonus: toInt(sumColumn("Move")),
    dodge_bonus: toInt(sumColumn("Dodge")),
    ballistic_armor: toInt(sumColumn("Ballistic Armor")),
    impact_armor: toInt(sumColumn("Impact Armor")),
    // Highest single innate ballistic source (for the max-ballistic cap).
    ballistic_armor_max: maxOf(traits.map(row => toInt(asNumber(row["Ballistic Armor"]))), 0),
    all_skills_bonus: toInt(sumColumn("All")),
    special_move_notes: traits.filter(row => row.SpecMove).map(row => row.SpecMove),
    skill_bonus: {
      "Observation": toInt(sumColumn("Observation")),
      "Reconnaissance": toInt(sumColumn("Recon")),
      "Shadow": toInt(sumColumn("Shadow")),
      "Athletics": toInt(sumColumn("Athletics")),
      "Sorcery": toInt(sumColumn("Sorcery")),
      "Conjuring": toInt(sumColumn("Conjuring")),
      "Channeling": toInt(sumColumn("Channeling")),
      "Astral Senses": toInt(sumColumn("AstralSenses")),
    },
    has_hephestus: traits.some(row => row.Name === "Hephestus"),
    has_cyclopean: traits.some(row => row.Name === "Cyclopean"),
    has_antlers: traits.some(row => row.Name === "Antlers"),
    gear_cost_multiplier: gearCostMult,
    armor_cost_multiplier: armorCostMult,
  };
}

function validateBoonBaneCounts(heritageType, categories, warnings, errors) {
  const count = label => categories.filter(c => c === label).length;
  if (heritageType === "Green") {
    const boons = count("GreenBoon"), banes = count("GreenBane");
    if (banes > 1) errors.push("Green heritage: choose at most 1 Bane.");
    const boonLimit = banes >= 1 ? 2 : 1;
    if (boons > boonLimit) {
      const unlockHint = boonLimit === 1 ? "take a Bane to unlock a 2nd" : "";
      errors.push(`Green heritage: ${boonLimit} Boon(s) allowed (${unlockHint}).`);
    } else if (boons < 1) {
      warnings.push("Green heritage: choose at least 1 Boon.");
    }
  } else if (heritageType === "Blighted") {
    const boons = count("BlightBoon"), banes = count("BlightBane");
    if (banes > 1) errors.push("Blighted heritage: choose at most 1 Bane.");
    const boonLimit = banes >= 1 ? 3 : 2;
    if (boons > boonLimit) {
      const unlockHint = boonLimit === 2 ? "take a Bane to unlock a 3rd" : "";
      errors.push(`Blighted heritage: ${boonLimit} Boon(s) allowed (${unlockHint}).`);
    } else if (boons < 2) {
      warnings.push("Blighted heritage: choose at least 2 Boons.");
    }
  }
}

// ============================================================== step 3: augments
const AUGMENT_REQUIREMENTS = {
  "Skillwires": [["Chipjack"]],
  "Skillsoft": [["Chipjack"], ["Skillwires"]],
  // Knowledge Skillsofts need only a single Chipjack (no Skillwires), no
  // matter how many are installed — each adds a Knowledge skill point.
  "Knowledge Skillsoft": [["Chipjack"]],
  "Pain Nullifier": [["Nerve Rig"]],
  "Subvocal Mic": [["Commlink"]],
  "Recorder": [["Datajack", "Optical Datajack", "Memory", "Chipjack"]],
  "Camera": [["Datajack", "Optical Datajack", "Memory", "Chipjack"]],
  "Cybergun Installation": [["Right Arm Replacement", "Left Arm Replacement",
                             "Arm Omni-kit"]],
  "Gyromount": [["Right Arm Replacement", "Left Arm Replacement",
                 "Arm Omni-kit"]],
};

const CYBER_SENSE_ZR_ABSORB = 0.5;
const CYBER_LIMB_ZR_ABSORB = 1.0;
const CYBER_EYES_NAME = "Cybertechtronic Eyes";
const CYBER_EARS_NAME = "Cybertechronic Ears";   // (sic — matches the data table)
const LIMB_REPLACEMENT_TYPES = ["Right Arm", "Left Arm", "Right Leg", "Left Leg"];

function augmentLevel(name) {
  const parts = String(name || "").trim().split(" ");
  const tail = parts[parts.length - 1];
  return /^\d+$/.test(tail) ? parseInt(tail, 10) : 0;
}

// Alpha-grade augments (bleeding edge): ZR reduced 20% (minimum reduction
// of 0.1, round UP to the nearest tenth) but cost is doubled (with a minimum
// increase of 1000). Flagged per-entry with entry.alpha. Shared by the
// body-augment tally, the gear-mount tally, and the UIs.
function augmentEffZr(row, entry) {
  const base = asNumber(row.ZR);
  if (!(entry && entry.alpha && base)) return base;
  // Alpha grade reduces ZR by 20% or 0.1, whichever is larger. round2 clears
  // float dust before the ceil so e.g. 0.4−0.1 = 0.30000000000000004 rounds to
  // 0.3 rather than getting ceil'd up to 0.4.
  const reduction = Math.max(base * 0.2, 0.1);
  return Math.max(0, Math.ceil(round2(base - reduction) * 10) / 10);
}
// Fashionware quality tiers (Ad Supported ×0.5 … Bespoke ×15). Only pieces
// flagged Quality = Y can be made at a tier; everything else ignores it.
function augmentQualityMultiplier(row, entry) {
  if (!(row && row.Quality === "Y" && entry && entry.quality)) return 1;
  const tier = (BUNDLE.tables.fashionware_qualities || [])
    .find(q => q.Quality === entry.quality);
  return tier ? asNumber(tier.Multiplier, 1) : 1;
}
function augmentEffCost(row, entry) {
  // Quality scales the base price first; α-grade then applies on top of the
  // quality-adjusted cost (issue #19).
  const base = asNumber(row.Cost) * augmentQualityMultiplier(row, entry);
  // Doubles the cost, but the increase is at least 1000 so cheap augments
  // still pay a real premium for bleeding-edge grade.
  let cost = (entry && entry.alpha) ? base + Math.max(base, 1000) : base;
  // Cybergun Installation: the chosen gun type adds its own cost on top of the
  // installation (added flat, after the α-grade premium on the installation).
  if (entry && entry.gunType) {
    const gun = (BUNDLE.tables.cyberguns || []).find(g => g.Type === entry.gunType);
    if (gun) cost += asNumber(gun.Cost);
  }
  return cost;
}

/**
 * A Cyberlimbs augment's limb requirement, driven by the data "Req Limb" field:
 *   "Arm" -> needs a cyberarm, "Leg" -> a cyberleg, "Any" -> either.
 * Hand implants (blades/razors) name-match to no requirement; any other
 * Cyberlimbs augment with no explicit field defaults to "Any". Returns "" for
 * non-cyberlimb augments and for augments that need no limb.
 */
function augmentLimbRequirement(row) {
  if (!row || row.Type !== "Cyberlimbs") return "";
  if (row["Req Limb"]) return row["Req Limb"];
  return /^(Hand Blade|Hand Razors)/.test(row.Name || "") ? "" : "Any";
}

/**
 * Computed damage for an augment that carries a structured "Damage" bonus —
 * cyber melee implants (Hand Blade/Razors, Spurs), Fangs, and the Eye Laser.
 * meleeDamage adds ½ STR by default, or the row's "STR Mult" (0 = fixed damage,
 * e.g. the Eye Laser). Returns "" for augments with no built-in attack.
 */
function augmentMeleeDamage(row, strength, martialMods) {
  if (!row || row.Damage === undefined || row.Damage === "") return "";
  // Way of the Tank L6 overrides spur damage to full STR + N (e.g. "6+STR").
  if (martialMods && martialMods.spurs_str_bonus != null && /spurs?/i.test(row.Name || ""))
    return String(strength + martialMods.spurs_str_bonus);
  return meleeDamage(row, strength);
}

// Melee attacks a character carries without a hand weapon — cyber implants
// (Hand Blade/Razors, Spurs, Fangs, …), and Amp powers such as Iron Fist that
// grant a bare-handed strike. Surfaced on the Overview loadout beside carried
// weapons so their auto-calculated (Strength-based) damage and Reach are visible
// in one place. Each: { name, damage, reach, source }.
function collectGrantedWeapons(augments, amp, strength, martialMods) {
  const list = [];
  // Cyber melee implants + Fangs: any owned augment with a structured Damage.
  for (const [row, count] of augments.rows) {
    const dmg = augmentMeleeDamage(row, strength, martialMods);
    if (dmg === "") continue;
    list.push({ name: count > 1 ? `${row.Name} ×${count}` : row.Name,
      damage: dmg, reach: 0, source: "Cyberware" });
  }
  // Iron Fist (Amp power): unarmed strikes deal physical ½STR + 6 at Reach 0.
  if (amp.powers_taken.has("Iron Fist")) {
    list.push({ name: "Iron Fist", damage: meleeDamage({ Damage: IRON_FIST_BASE_DAMAGE }, strength),
      reach: 0, source: "Amp Power" });
  }
  return list;
}

// Curated natural attacks granted by heritage uplifts (issue #9). Gorilla is a
// pure reach modifier (surfaced as a heritage ability, not a weapon). Shark and
// Snake grant bite/spit attacks; Snake's is a chargen-locked bite-or-spit pick.
function heritageNaturalWeapons(heritage, character, strength) {
  const has = n => heritage.traits.some(row => row.Name === n);
  const list = [];
  if (has("Shark"))
    list.push({ name: "Bite", damage: String(6 + strength), reach: 0, source: "Shark" });  // 6 + full STR
  if (has("Snake")) {
    if ((character.heritage.snake_attack || "bite") === "spit")
      list.push({ name: "Spit", source: "Snake",
        stats: `Ranged 12m · Acc 4 · DMG 2d6 · +Blind` });
    else
      list.push({ name: "Bite", damage: `${Math.floor(strength / 2) + 1} +3d6 poison`,
        reach: 0, source: "Snake" });
  }
  return list;
}

// Effect sums shared by body-installed augments (tallyAugments) and augments
// mounted on gear (tallyMountedAugments). `owned` is [row, count, entry]
// tuples; entries that shouldn't grant effects (e.g. mounted on unworn gear)
// are simply left out of the list by the caller.
function augmentEffectSums(owned) {
  const names = new Set(owned.map(([row]) => row.Name));
  const attributeAdjustment = {}, attributeMaxAdjustment = {};
  for (const name of ATTRIBUTES) { attributeAdjustment[name] = 0; attributeMaxAdjustment[name] = 0; }
  for (const name of ["Strength", "Body", "Reaction", "Intelligence"]) {
    attributeAdjustment[name] = toInt(sumBy(owned,
      ([row, count]) => asNumber(row[name]) * count));
    attributeMaxAdjustment[name] = toInt(sumBy(owned,
      ([row, count]) => AUGMENTS_THAT_RAISE_MAX.some(p => row.Name.startsWith(p))
        ? asNumber(row[name]) * count : 0));
  }
  const wiredReflexesRank = maxOf(
    [...names].filter(n => n.startsWith("Wired Reflexes")).map(augmentLevel), 0);
  const skillBonus = {};
  if (names.has("Sound Filter")) {
    skillBonus["Observation"] = SOUND_FILTER_OBSERVATION_BONUS;
  }
  // Situational skill dice that can't be a flat bonus (jump-only, conceal-only,
  // reroll effects) surface as per-skill notes instead of inflating the rank.
  const skillNotes = {};
  const addSkillNote = (skill, note) =>
    (skillNotes[skill] = skillNotes[skill] || []).push(note);
  if (names.has("Rocket Boots")) addSkillNote("Athletics", "+8d & reroll 1s/2s when jumping (Rocket Boots)");
  if (names.has("Compartment")) addSkillNote("Subterfuge", "+6d to conceal an item in the body compartment");
  if (names.has("Covert Synthskin")) addSkillNote("Shadow", "reroll 1s/2s while hiding in appropriate gear (Covert Synthskin)");
  if (names.has("Amplification")) addSkillNote("Observation", "reroll 1s (Amplification)");
  // Situational firearm/optics modifiers, shown as reminders by the weapons UI.
  const combatNotes = [];
  if (names.has("Smartlink")) combatNotes.push("Smartlink: +1 Accuracy on smart guns (already applied)");
  if (names.has("Laser Designator")) combatNotes.push("Laser Designator: +1 Accuracy when the laser is lit");
  if (names.has("Augmented Eyesight")) combatNotes.push("Augmented Eyesight: shift firearm range one category closer");
  for (const [row] of owned) {
    if (row.Name.startsWith("Vision Magnification"))
      combatNotes.push(`${row.Name}: reduce firearm range by ${augmentLevel(row.Name)}`);
  }
  // Special senses / immunities (curated) and alternate movement modes (Mobi
  // augments with an AltMove value) surface as summaries; damage soak is a flag.
  const senseNotes = owned
    .filter(([row]) => SENSE_AUGMENTS.has(row.Name))
    .map(([row]) => ({ name: row.Name, effect: row.Effect || "" }));
  const moveModes = owned
    .filter(([row]) => row.AltMove !== undefined && row.AltMove !== "")
    .map(([row]) => ({ name: row.Name, mode: row.MoveMode || "Alt", meters: toInt(asNumber(row.AltMove)) }));
  return {
    attribute_adjustment: attributeAdjustment,
    attribute_max_adjustment: attributeMaxAdjustment,
    skill_bonus: skillBonus,
    skill_notes: skillNotes,
    combat_notes: combatNotes,
    sense_notes: senseNotes,
    move_modes: moveModes,
    physical_damage_reduction: names.has("Platelet Production Enhancement") ? PLATELET_DAMAGE_REDUCTION : 0,
    move_bonus: toInt(sumBy(owned, ([row, count]) =>
      row.Name.startsWith("Movement Enhancement")
        ? augmentLevel(row.Name) * MOVEMENT_ENHANCEMENT_METERS_PER_RATING * count : 0)),
    // Recoil-capacity bonus: each Gyromount adds +2.
    recoil_capacity_bonus: toInt(sumBy(owned, ([row, count]) =>
      row.Name === "Gyromount" ? GYROMOUNT_RECOIL_BONUS * count : 0)),
    dodge_bonus: names.has("Covert Synthskin") ? COVERT_SYNTHSKIN_DODGE_BONUS : 0,
    impact_armor: toInt(sumBy(owned, ([row, count]) => asNumber(row["Impact Armor"]) * count)),
    ballistic_armor: toInt(sumBy(owned, ([row, count]) => asNumber(row["Ballistic Armor"]) * count)),
    // Un-strippable impact armor (ImpArmMin col: Bone Lacing, Bone Density, …).
    impact_armor_min: toInt(sumBy(owned, ([row, count]) => asNumber(row.ImpArmMin) * count)),
    // Highest single ballistic source (ballistic armor doesn't stack for the cap).
    ballistic_armor_max: maxOf(owned.map(([row]) => toInt(asNumber(row["Ballistic Armor"]))), 0),
    melee_exploit_bonus: WIRED_REFLEXES_MELEE_EXPLOITS_BY_RANK[wiredReflexesRank] || 0,
    wired_reflexes_rank: wiredReflexesRank,
    internal_armor_slot_items: owned
      .filter(([row]) => row["Armor Slot"] === "Y")
      .map(([row]) => row.Name),
    mobility_move_notes: owned
      .filter(([row]) => row.Type === "Mobi" && row.Effect)
      .map(([row]) => row.Effect),
    has_move_exploit: owned.some(([row]) =>
      row.Name.includes("Trackmobi") || row.Name.includes("Repulsors")),
    // Named sources of the move exploit action, so the Overview can attribute it.
    move_exploit_sources: owned
      .filter(([row]) => row.Name.includes("Trackmobi") || row.Name.includes("Repulsors"))
      .map(([row]) => row.Name),
  };
}

function tallyAugments(character, data, warnings, errors) {
  const owned = [];  // [row, count, character entry]
  for (const entry of character.augments) {
    const row = findRow(data.augments, "Name", entry.name);
    if (row) owned.push([row, toInt(asNumber(entry.count, 1)) || 1, entry]);
  }

  const ownedNames = new Set(owned.map(([row]) => row.Name));
  const owns = prefix => [...ownedNames].some(name => name.startsWith(prefix));

  const hasVcr = (character.rigs || []).some(
    rig => findRow(data.rigs, "Rig Type", rig.name));
  if (character.heritage.type === "Synthetic") {
    for (const [row] of owned) {
      if (row.Type === "Bioware") {
        errors.push(`${row.Name}: Synthetics cannot have Bioware installed.`);
      }
    }
  }

  for (const [row] of owned) {
    const banned = String(row.Ban || "").split(",").map(n => n.trim()).filter(Boolean);
    for (const bannedName of banned) {
      if (bannedName === "VCR") {
        if (hasVcr) {
          errors.push(`Augment conflict: ${row.Name} is incompatible `
                      + "with a Vehicle Control Rig.");
        }
      } else if ([...ownedNames].some(name => name !== row.Name && name.startsWith(bannedName))) {
        errors.push(`Augment conflict: ${row.Name} is incompatible with ${bannedName}.`);
      }
    }
  }

  for (const [row] of owned) {
    for (const [prefix, groups] of Object.entries(AUGMENT_REQUIREMENTS)) {
      if (!row.Name.startsWith(prefix)) continue;
      for (const group of groups) {
        if (!group.some(alternative => owns(alternative))) {
          errors.push(`${row.Name} requires ${group.join(" or ")}.`);
        }
      }
      break;
    }
  }

  const skillwireRating = maxOf(
    [...ownedNames].filter(n => n.startsWith("Skillwires")).map(augmentLevel), 0);
  // Only a slotted Skillsoft grants its bonus; how many can be slotted at
  // once is capped by the number of Chipjacks installed.
  const chipjackCount = owned
    .filter(([row]) => row.Name === "Chipjack")
    .reduce((sum, [, count]) => sum + count, 0);
  const skillsoftLevels = {};
  let slottedSkillsoftCount = 0;
  for (const [row, , entry] of owned) {
    if (!row.Name.startsWith("Skillsoft")) continue;
    const level = augmentLevel(row.Name);
    const target = entry.target || "";
    if (!(target in SKILLS)) {
      warnings.push(`${row.Name}: choose the skill it grants.`);
      continue;
    }
    if (skillwireRating && level > skillwireRating) {
      errors.push(`${row.Name} (${target}) needs Skillwires rating ${level} — `
                  + `yours is ${skillwireRating}.`);
    }
    if (entry.slotted === false) continue;
    slottedSkillsoftCount++;
    skillsoftLevels[target] = Math.max(skillsoftLevels[target] || 0, level);
  }
  if (slottedSkillsoftCount > chipjackCount) {
    errors.push(`${slottedSkillsoftCount} Skillsoft(s) slotted but only `
                + `${chipjackCount} Chipjack(s) installed.`);
  }

  const eyewareModCount = sumBy(owned, ([row, count]) =>
    (row.Type === "Eyeware" && row.Name !== CYBER_EYES_NAME) ? count : 0);
  if (eyewareModCount > 1 && !ownedNames.has(CYBER_EYES_NAME)) {
    errors.push(`More than 1 Eyeware augment requires ${CYBER_EYES_NAME}.`);
  }

  const strengthEnhancementRank = maxOf(
    [...ownedNames].filter(n => n.startsWith("Strength Enhancement")).map(augmentLevel), 0);
  const muscleReplacementRank = maxOf(
    [...ownedNames].filter(n => n.startsWith("Muscle Replacement")).map(augmentLevel), 0);
  if (strengthEnhancementRank > muscleReplacementRank) {
    warnings.push(`Strength Enhancement ${strengthEnhancementRank} needs Muscle `
                  + `Replacement ${strengthEnhancementRank}+ (you have `
                  + `${muscleReplacementRank}) — you risk injury when exerting yourself.`);
  }

  const effZr = augmentEffZr, effCost = augmentEffCost;

  const typeZr = (typeName, exclude = []) => sumBy(owned, ([row, count, entry]) =>
    (row.Type === typeName && !exclude.includes(row.Name))
      ? effZr(row, entry) * count : 0);

  const rawZr = sumBy(owned, ([row, count, entry]) => effZr(row, entry) * count);
  let zrAbsorbed = 0.0;
  if (ownedNames.has(CYBER_EYES_NAME)) {
    zrAbsorbed += Math.min(CYBER_SENSE_ZR_ABSORB, typeZr("Eyeware", [CYBER_EYES_NAME]));
  }
  if (ownedNames.has(CYBER_EARS_NAME)) {
    zrAbsorbed += Math.min(CYBER_SENSE_ZR_ABSORB, typeZr("Earware", [CYBER_EARS_NAME]));
  }
  const limbCount = sumBy(owned, ([row, count]) =>
    LIMB_REPLACEMENT_TYPES.includes(row.Type) ? count : 0);
  if (limbCount) {
    zrAbsorbed += Math.min(CYBER_LIMB_ZR_ABSORB * limbCount, typeZr("Cyberlimbs"));
  }

  // Each installed Knowledge Skillsoft grants one extra Knowledge skill point.
  const knowledgePointsBonus = toInt(sumBy(owned, ([row, count]) =>
    row.Name === "Knowledge Skillsoft" ? count : 0));

  return {
    ...augmentEffectSums(owned),
    rows: owned,
    zoetic_rating: round2(Math.max(0.0, rawZr - zrAbsorbed)),
    zoetic_rating_raw: round2(rawZr),
    body_index: sumBy(owned, ([row, count]) => asNumber(row.BI) * count),
    cost: sumBy(owned, ([row, count, entry]) => effCost(row, entry) * count),
    // Bioware is grown to fit, so it never carries the small-heritage surcharge.
    bioware_cost: sumBy(owned, ([row, count, entry]) =>
      row.Type === "Bioware" ? effCost(row, entry) * count : 0),
    skillsoft_levels: skillsoftLevels,
    knowledge_points_bonus: knowledgePointsBonus,
    has_hyperthyroid: ownedNames.has("Hyperthyroid"),
  };
}

// ============================================================== step 3b: gear mounts
// Gear rows carrying a "Mount Types" column can host non-Bioware augments
// (Power Armor, Arwin Goggles, homebrew). Mounted augments live on the host
// entry's `mounted` array ({name, alpha}) — they are bought and managed with
// the gear, never appear in character.augments, and their ZR must fit the
// host's "Mount ZP" capacity. That ZR never touches the character's ZP, and
// their effects apply only while the host is worn / carried / equipped.
// Augments no host can ever mount, whatever its Mount Types say. Skillsofts
// are Headware, so an "Any" host would otherwise offer them — but a Skillsoft
// only runs from a Chipjack wired into your head, never from a gear device.
const MOUNT_EXCLUDED_RE = /^(Skillsoft|Knowledge Skillsoft)/;

function mountCapability(row) {
  const raw = String(row["Mount Types"] || "").trim();
  if (!raw) return null;
  const types = raw.split(",").map(t => t.trim()).filter(Boolean);
  const any = types.some(t => t.toLowerCase() === "any");
  return {
    types, any,
    capacity: asNumber(row["Mount ZP"]),
    // Takes an augment row: the Skillsoft exclusion is by name, not by type.
    accepts: aug => aug.Type !== "Bioware" && !MOUNT_EXCLUDED_RE.test(aug.Name || "")
                    && (any || types.includes(aug.Type)),
    label: any ? "any non-Bioware augment" : types.join(", "),
  };
}

// Why a host refuses an augment — shown as a warning (engine) or as the
// disabled Add button's tooltip (UI).
function mountRefusal(hostName, row, cap) {
  if (row.Type === "Bioware") {
    return `${hostName} cannot mount ${row.Name}: Bioware can't be mounted in gear.`;
  }
  if (MOUNT_EXCLUDED_RE.test(row.Name || "")) {
    return `${hostName} cannot mount ${row.Name}: Skillsofts must be slotted in a Chipjack.`;
  }
  return `${hostName} cannot mount ${row.Name} (${row.Type || "?"}) — `
         + `it accepts ${cap.label}.`;
}

function tallyMountedAugments(character, data, warnings, errors) {
  // [entries, table, name column, host-active test, copies owned]
  const hostKinds = [
    [character.armor || [], data.armor, "Armor",
     e => e.active !== false, () => 1],
    [character.weapons || [], data.weapons, "Weapon",
     e => e.equipped !== false, e => Math.max(1, toInt(asNumber(e.qty, 1)))],
    [character.gear || [], data.misc_gear, "Item",
     e => e.carried !== false, e => Math.max(1, toInt(asNumber(e.qty, 1)))],
  ];

  const active = [];   // [row, 1, mounted entry] — feeds the shared effect sums
  const mountErrors = [];
  let cost = 0.0, totalZr = 0.0;
  for (const [entries, table, nameColumn, isActive, copies] of hostKinds) {
    for (const host of entries) {
      const mountedList = host.mounted || [];
      if (!mountedList.length) continue;
      const hostRow = findRow(table, nameColumn, host.name);
      const cap = hostRow && mountCapability(hostRow);
      if (!cap) {
        warnings.push(`${host.name} cannot mount augments — remove the augments mounted on it.`);
        continue;
      }
      let used = 0.0;
      for (const mount of mountedList) {
        const row = findRow(data.augments, "Name", mount.name);
        if (!row) continue;
        cost += augmentEffCost(row, mount);
        used += augmentEffZr(row, mount);
        if (!cap.accepts(row)) {
          warnings.push(mountRefusal(host.name, row, cap));
        } else if (isActive(host)) {
          active.push([row, 1, mount]);
        }
      }
      const capacity = round2(cap.capacity * copies(host));
      if (used - capacity > 1e-9) {
        mountErrors.push(`Overloaded Mount: ${host.name} holds ZR ${round2(used)} `
                         + `of mounted augments — its capacity is ${capacity} ZP.`);
      }
      totalZr += used;
    }
  }
  errors.push(...mountErrors);
  return { ...augmentEffectSums(active), rows: active, cost,
           mounted_zr: round2(totalZr), mount_errors: mountErrors };
}

// Fold gear-mounted augments' cost and active effects into the body-augment
// tally so every downstream consumer (attributes, combat, initiative notes,
// wound-penalty scan) sees them without special-casing. The ZR fields are
// deliberately untouched: mounted ZR never counts against the character.
function mergeMountedAugments(augments, mounted) {
  augments.cost += mounted.cost;
  for (const name of ATTRIBUTES) {
    augments.attribute_adjustment[name] += mounted.attribute_adjustment[name];
    augments.attribute_max_adjustment[name] += mounted.attribute_max_adjustment[name];
  }
  for (const [skill, bonus] of Object.entries(mounted.skill_bonus)) {
    augments.skill_bonus[skill] = Math.max(augments.skill_bonus[skill] || 0, bonus);
  }
  for (const [skill, notes] of Object.entries(mounted.skill_notes || {})) {
    (augments.skill_notes[skill] = augments.skill_notes[skill] || []).push(...notes);
  }
  augments.move_bonus += mounted.move_bonus;
  augments.recoil_capacity_bonus += mounted.recoil_capacity_bonus || 0;
  augments.dodge_bonus = Math.max(augments.dodge_bonus, mounted.dodge_bonus);
  augments.impact_armor += mounted.impact_armor;
  augments.ballistic_armor += mounted.ballistic_armor;
  augments.impact_armor_min += mounted.impact_armor_min;
  augments.ballistic_armor_max = Math.max(augments.ballistic_armor_max,
                                          mounted.ballistic_armor_max);
  augments.melee_exploit_bonus = Math.max(augments.melee_exploit_bonus,
                                          mounted.melee_exploit_bonus);
  augments.internal_armor_slot_items.push(...mounted.internal_armor_slot_items);
  augments.mobility_move_notes.push(...mounted.mobility_move_notes);
  augments.combat_notes.push(...(mounted.combat_notes || []));
  augments.sense_notes.push(...(mounted.sense_notes || []));
  augments.move_modes.push(...(mounted.move_modes || []));
  augments.physical_damage_reduction = Math.max(augments.physical_damage_reduction,
                                                 mounted.physical_damage_reduction || 0);
  augments.has_move_exploit = augments.has_move_exploit || mounted.has_move_exploit;
  augments.move_exploit_sources.push(...(mounted.move_exploit_sources || []));
  augments.rows.push(...mounted.rows);
  augments.mounted_zr = mounted.mounted_zr;
  augments.mount_errors = mounted.mount_errors;
}

// ============================================================== step 4: amp powers
function tallyAmpPowers(character, data, magicType, warnings, errors) {
  let zpSpent = 0.0;
  const attributeAdjustment = {}, attributeMaxAdjustment = {};
  for (const name of ATTRIBUTES) { attributeAdjustment[name] = 0; attributeMaxAdjustment[name] = 0; }
  const skillBonus = {};
  const powersTaken = new Set();

  const eligible = magicType === "Amp" || magicType === "Archmage";
  const requestedPowers = character.magic.amp_powers || [];
  if (!eligible) {
    if (requestedPowers.length) {
      warnings.push("Amp powers require Amp or Archmage magic type.");
    }
    return { spent: 0.0, attribute_adjustment: attributeAdjustment,
             attribute_max_adjustment: attributeMaxAdjustment,
             skill_bonus: skillBonus, powers_taken: powersTaken,
             expertise_skills: new Set() };
  }

  const costMultiplier = magicType === "Amp" ? AMP_COST_MULTIPLIER : 1.0;
  const expertiseSkills = new Set();
  for (const entry of requestedPowers) {
    const row = findRow(data.amp_powers, "Name", entry.name);
    if (!row) continue;
    const times = Math.max(1, toInt(asNumber(entry.times, 1)));
    zpSpent += asNumber(row["ZP Cost"]) * costMultiplier * times;
    powersTaken.add(row.Name);
    const target = entry.target || "";

    if (row.Name === "Attribute Boost" && ATTRIBUTES.includes(target)) {
      attributeAdjustment[target] += times;
      attributeMaxAdjustment[target] += times;
    } else if (row.Name === "Attribute Increase" && ATTRIBUTES.includes(target)) {
      attributeAdjustment[target] += times;
    } else if (row.Name === "Expertise" && (target in SKILLS)) {
      skillBonus[target] = (skillBonus[target] || 0) + EXPERTISE_SKILL_BONUS * times;
      expertiseSkills.add(target);
    } else if (row.Name === "Eyes of the Raptor") {
      skillBonus["Firearms"] = (skillBonus["Firearms"] || 0) + 2;
    } else if (row.Name === "Might of the Bear") {
      skillBonus["Unarmed Combat"] = (skillBonus["Unarmed Combat"] || 0) + 2;
    } else if (row.Name === "Sting of the Scorpion") {
      skillBonus["Melee Weapons"] = (skillBonus["Melee Weapons"] || 0) + 2;
    } else if (row.Name === "Hidden Presence") {
      skillBonus["Shadow"] = (skillBonus["Shadow"] || 0) + 2;
      skillBonus["Subterfuge"] = (skillBonus["Subterfuge"] || 0) + 2;
    }
  }

  return {
    spent: zpSpent,
    attribute_adjustment: attributeAdjustment,
    attribute_max_adjustment: attributeMaxAdjustment,
    skill_bonus: skillBonus,
    powers_taken: powersTaken,
    expertise_skills: expertiseSkills,
  };
}

// ============================================================== step 5: attributes
function cumulativeAttributeCost(level, costTable) {
  const clampedLevel = Math.max(ATTRIBUTE_LEVEL_MIN,
    Math.min(toInt(level), ATTRIBUTE_LEVEL_MAX));
  return costTable[clampedLevel] !== undefined ? costTable[clampedLevel] : clampedLevel;
}

function scoreAttributes(character, data, startingAttributePoints, heritage, augments, amp,
                         warnings, errors) {
  const costTable = {};
  for (const row of data.attribute_costs) costTable[toInt(Number(row.Level))] = toInt(Number(row.Cost));
  const baseLevel = {};
  for (const name of ATTRIBUTES) {
    baseLevel[name] = Math.max(1, toInt(asNumber(character.attributes[name], 1)));
  }
  const pointsSpent = sumBy(Object.values(baseLevel),
    level => cumulativeAttributeCost(level, costTable));
  const pointsRemaining = (MANDATORY_ATTRIBUTE_REFUND + startingAttributePoints
                           - pointsSpent + heritage.uplift_attribute_point_modifier);
  if (pointsRemaining < 0) {
    errors.push(`Attribute points overspent by ${-pointsRemaining}.`);
  }

  const attributes = {};
  for (const name of ATTRIBUTES) {
    const adjustment = (heritage.attribute_adjustment[name]
                        + augments.attribute_adjustment[name]
                        + amp.attribute_adjustment[name]);
    const finalValue = baseLevel[name] + adjustment;
    const maxValue = (ATTRIBUTE_MAX_BASELINE
                      + heritage.attribute_max_adjustment[name]
                      + heritage.attribute_adjustment[name]
                      + augments.attribute_max_adjustment[name]
                      + amp.attribute_max_adjustment[name]);
    attributes[name] = { base: baseLevel[name], adjust: adjustment,
                         final: finalValue, max: maxValue };
    if (finalValue > maxValue) {
      warnings.push(`${name} ${finalValue} exceeds its maximum of ${maxValue}.`);
    }
  }

  const finals = {};
  for (const name of ATTRIBUTES) finals[name] = attributes[name].final;

  return {
    attributes,
    final: finals,
    points: { budget: startingAttributePoints,
              uplift_mod: heritage.uplift_attribute_point_modifier,
              spent: pointsSpent - MANDATORY_ATTRIBUTE_REFUND,
              remaining: pointsRemaining },
  };
}

// ============================================================== step 3b: pools
function computePools(finalAttributes, chaPoolChoice) {
  const charismaQuarterShare = finalAttributes.Charisma * 0.25;
  const pools = {
    Brawn: (finalAttributes.Strength
            + 0.5 * finalAttributes.Body
            + 0.25 * finalAttributes.Willpower),
    Finesse: (0.5 * finalAttributes.Body
              + finalAttributes.Reaction
              + 0.25 * finalAttributes.Intelligence),
    Focus: (0.5 * finalAttributes.Reaction
            + finalAttributes.Intelligence
            + 0.25 * finalAttributes.Willpower),
    Resolve: (0.5 * finalAttributes.Intelligence
              + finalAttributes.Willpower
              + 0.5 * finalAttributes.Charisma),
  };
  if (chaPoolChoice in pools) pools[chaPoolChoice] += charismaQuarterShare;
  const floored = {};
  for (const [pool, value] of Object.entries(pools)) floored[pool] = Math.floor(value);
  return floored;
}

// ============================================================== step 6: skills
function scoreSkills(character, heritage, amp, augments, warnings, errors) {
  const skillPoints = {};
  for (const [name, value] of Object.entries(character.skills)) {
    if (name in SKILLS) skillPoints[name] = toInt(asNumber(value));
  }
  let pointsSpent = sumBy(Object.values(skillPoints), points => Math.max(0, points));

  // Martial arts: each chosen style is an independent skill at 2 pts/rank, and
  // no style may exceed Unarmed Combat rank. (Martial Arts isn't in `skills`, so
  // it's costed separately here.)
  const unarmedRank = Math.max(0, skillPoints["Unarmed Combat"] || 0);
  for (const ma of character.martial_arts || []) {
    const rank = Math.max(0, toInt(asNumber(ma.rank)));
    pointsSpent += rank * MARTIAL_ARTS_COST_MULTIPLIER;
    if (rank > unarmedRank)
      errors.push(`Martial Arts (${ma.style || "unnamed style"}) rank ${rank} cannot exceed Unarmed Combat rank ${unarmedRank}.`);
    if (rank > SKILL_RANK_CAP)
      warnings.push(`Martial Arts (${ma.style || "unnamed style"}): maximum ${SKILL_RANK_CAP} points at creation.`);
  }

  const ritualSkills = {};
  for (const [name, points] of Object.entries(character.ritual_skills || {})) {
    ritualSkills[name] = Math.max(0, toInt(asNumber(points)));
  }
  for (const [name, points] of Object.entries(ritualSkills)) {
    if (points > SKILL_RANK_CAP) {
      warnings.push(`Ritual ${name}: maximum ${SKILL_RANK_CAP} points at creation.`);
    }
  }
  pointsSpent += sumBy(Object.values(ritualSkills), v => v);

  const groups = {};
  for (const [name, [, group]] of Object.entries(SKILLS)) {
    if (group) (groups[group] = groups[group] || []).push(name);
  }

  const expertiseSkills = amp.expertise_skills || new Set();
  const skillsoftLevels = augments.skillsoft_levels || {};
  const results = {};
  for (const [name, [pool, group]] of Object.entries(SKILLS)) {
    const points = Math.max(0, skillPoints[name] || 0);
    if (points > SKILL_RANK_CAP) {
      warnings.push(`${name}: maximum ${SKILL_RANK_CAP} skill points at creation.`);
    }

    let bonus = ((heritage.skill_bonus[name] || 0)
                 + heritage.all_skills_bonus
                 + (amp.skill_bonus[name] || 0)
                 + ((augments.skill_bonus || {})[name] || 0));
    if (name.startsWith("Engineering") && heritage.has_hephestus) {
      bonus += HEPHESTUS_ENGINEERING_BONUS;
    }
    if (RANGED_ATTACK_SKILLS.includes(name) && heritage.has_cyclopean) {
      bonus -= CYCLOPEAN_RANGED_PENALTY;
    }
    if (heritage.specialization_pool === pool) bonus += 1;

    let groupValue = null;
    if (group && points === 0) {
      const bestFallback = maxOf(groups[group].map(sibling =>
        Math.max(0, skillPoints[sibling] || 0)
        - (expertiseSkills.has(sibling) ? 0 : GROUP_FALLBACK_PENALTY)), 0);
      const bestTrained = maxOf(groups[group].map(sibling =>
        Math.max(0, skillPoints[sibling] || 0)), 0);
      // Untrained group fallback needs a sibling trained strictly above
      // GROUP_FALLBACK_MIN_TRAINED (i.e. rank 3+); a sibling at exactly the
      // threshold does not unlock it.
      if (bestTrained > GROUP_FALLBACK_MIN_TRAINED) {
        groupValue = bestFallback + bonus;
      }
    }

    const softLevel = skillsoftLevels[name] || 0;
    // Group fallback dice count toward final, so an untrained skill with a
    // trained group sibling rolls its group dice with no special notation.
    results[name] = { points, bonus,
                      final: Math.max(points + bonus, softLevel, groupValue || 0),
                      soft: softLevel,
                      pool, group, group_value: groupValue,
                      notes: (augments.skill_notes || {})[name] || [] };
  }

  return {
    skills: results,
    ritual_skills: ritualSkills,
    points: { budget: null, spent: pointsSpent },
  };
}

// Short forms used in gear/drone effect text -> canonical skill name.
const SKILL_ALIASES = {
  "Reconnaissance": ["Reconnaissance", "Recon"],
  "Computer: Hacking": ["Computer: Hacking", "Hacking"],
  "Computer: Programming": ["Computer: Programming", "Programming"],
};

/**
 * Bonus skill DICE granted by active + linked drones (play mode). A linked
 * drone contributes the numeric bonus it lists per skill, e.g. the Bug-Spy's
 * "+1 to Observation/Recon" becomes +1d to Observation and Reconnaissance.
 * Returns { skillName: dice }. Only drones currently feed this layer, so it
 * never double-counts the heritage/augment bonuses already folded into rank.
 */
function droneSkillDice(character, data) {
  const bonus = {};
  const linked = ((character.play || {}).rigging || {}).linked || {};
  const drones = character.drones || [];
  const aliasesFor = skill => SKILL_ALIASES[skill] || [skill];
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [key, on] of Object.entries(linked)) {
    if (!on || !key.startsWith("drones:")) continue;
    const unit = drones[+key.split(":")[1]];
    if (!unit) continue;
    const effect = (findRow(data.drones, "Drone", unit.name) || {}).Effect || "";
    for (const clause of effect.split(/[,.;]/)) {
      const m = clause.match(/([+-]?\d+)\s*d?/);
      const n = m ? parseInt(m[1], 10) : 0;
      if (!n) continue;
      for (const skill of Object.keys(SKILLS)) {
        if (aliasesFor(skill).some(a => new RegExp(`\\b${escape(a)}\\b`, "i").test(clause))) {
          bonus[skill] = (bonus[skill] || 0) + n;
        }
      }
    }
  }
  return bonus;
}

function scoreKnowledgeSkills(character, finalIntelligence, finalCharisma,
                             knowledgePointsBonus, warnings, errors) {
  const knowledgeBudget = KNOWLEDGE_POINTS_PER_INTELLIGENCE * finalIntelligence
                          + toInt(asNumber(knowledgePointsBonus));
  const knowledgeSpent = sumBy(character.knowledge_skills,
    entry => toInt(asNumber(entry.points)));
  if (knowledgeSpent > knowledgeBudget) {
    errors.push("Knowledge skill points overspent.");
  }
  for (const entry of character.knowledge_skills) {
    if (toInt(asNumber(entry.points)) > KNOWLEDGE_ETIQUETTE_RANK_CAP) {
      errors.push(`Knowledge ${entry.name || "(unnamed)"}: `
                  + `maximum ${KNOWLEDGE_ETIQUETTE_RANK_CAP} points.`);
    }
  }

  const etiquetteValues = {};
  for (const [name, points] of Object.entries(character.etiquettes || {})) {
    if (ETIQUETTES.includes(name)) etiquetteValues[name] = Math.max(0, toInt(asNumber(points)));
  }
  const etiquetteBudget = ETIQUETTE_POINTS_PER_CHARISMA * finalCharisma;
  const etiquetteSpent = sumBy(Object.values(etiquetteValues), v => v);
  if (etiquetteSpent > etiquetteBudget) {
    errors.push("Etiquette points overspent.");
  }
  for (const [name, points] of Object.entries(etiquetteValues)) {
    if (points > KNOWLEDGE_ETIQUETTE_RANK_CAP) {
      errors.push(`Etiquette ${name}: maximum ${KNOWLEDGE_ETIQUETTE_RANK_CAP} points.`);
    }
  }

  return {
    knowledge: { budget: knowledgeBudget, spent: knowledgeSpent,
                 remaining: knowledgeBudget - knowledgeSpent },
    etiquettes: { values: etiquetteValues, budget: etiquetteBudget,
                  spent: etiquetteSpent,
                  remaining: etiquetteBudget - etiquetteSpent },
  };
}

// ============================================================== step 7: magic budgets
function budgetMagic(character, data, magicType, warnings, errors) {
  const startForce = STARTING_FORCE_BY_MAGIC_TYPE[magicType] || 0;
  let forceSpent = sumBy(character.magic.spells || [],
    spell => Math.max(0, toInt(asNumber(spell.force))));
  for (const spell of character.magic.spells || []) {
    if (toInt(asNumber(spell.force)) > SPELL_FORCE_MAX) {
      errors.push(`Spell ${spell.name || "(unnamed)"}: `
                  + `maximum Force is ${SPELL_FORCE_MAX}.`);
    }
  }
  if (magicType === "Archmage" && character.magic.archmage_bind) {
    forceSpent += ARCHMAGE_SPIRIT_BIND_FORCE_COST;
  }

  if (magicType === "Mage") {
    const school = character.magic.school;
    if (!school) warnings.push("Mage: choose one School of magic.");
    for (const spell of character.magic.spells || []) {
      const row = findRow(data.spells, "Name", spell.name);
      if (row && school && row.School !== school) {
        errors.push(`Spell ${spell.name} is outside your school (${school}).`);
      }
    }
  }
  if (magicType !== "Mage" && magicType !== "Archmage" && (character.magic.spells || []).length) {
    warnings.push("Spells require Mage or Archmage magic type.");
  }

  let infusionSpent = 0, relationshipSpent = 0, bondSpent = 0;
  if (magicType === "Speaker" || magicType === "Archmage") {
    for (const name of character.speaker.infusions || []) {
      const row = findRow(data.speaker_infusions, "Infusions", name);
      infusionSpent += row ? toInt(asNumber(row.Cost)) : 0;
    }
    for (const name of character.speaker.relationships || []) {
      const row = findRow(data.speaker_spirits, "Spirit", name);
      relationshipSpent += row ? toInt(asNumber(row.Cost)) : 0;
    }
    const bondCostByIndex = {};
    for (const row of data.speaker_bond_costs) {
      bondCostByIndex[toInt(Number(row.Bond))] = toInt(asNumber(row.Cost));
    }
    const bondCount = Math.max(0, Math.min(4, toInt(asNumber(character.speaker.bonds))));
    for (let i = 1; i <= bondCount; i++) bondSpent += bondCostByIndex[i] || 0;
  }

  if (magicType === "Archmage") {
    forceSpent += infusionSpent + relationshipSpent + bondSpent;
  }
  const forceRemaining = startForce - forceSpent;
  if ((magicType === "Mage" || magicType === "Archmage") && forceRemaining < 0) {
    errors.push(`Starting Force overspent by ${-forceRemaining}.`);
  }

  const infusionBudget = magicType === "Speaker" ? SPEAKER_INFUSION_POINTS : 0;
  const relationshipBudget = magicType === "Speaker" ? SPEAKER_RELATIONSHIP_POINTS : 0;
  const infusionRemaining = infusionBudget - infusionSpent;
  const relationshipRemaining = relationshipBudget - relationshipSpent - bondSpent;
  if (magicType === "Speaker") {
    if (infusionRemaining < 0) errors.push("Infusion points overspent.");
    if (relationshipRemaining < 0) errors.push("Relationship points overspent.");
  }

  return {
    start_force: startForce,
    force_spent: forceSpent,
    force_remaining: forceRemaining,
    infusion_pts: { budget: infusionBudget, spent: infusionSpent,
                    remaining: infusionRemaining },
    relationship_pts: { budget: relationshipBudget,
                        spent: relationshipSpent + bondSpent,
                        remaining: relationshipRemaining },
  };
}

// ============================================================== step 8: gear pricing
/**
 * Assign fitted mod names to a weapon's three slots (Overbarrel / Underbarrel /
 * Chassis), one mod per slot. Single-slot mods claim their slot first; dual-slot
 * mods (e.g. Laser Sight, which fits either barrel slot) then take whichever of
 * their candidate slots is still free. Mods not in the table are ignored.
 * Returns { assigned: {slot: modName}, overflow: [modName] } where overflow is
 * every mod left without a free slot.
 */
function assignWeaponModSlots(modNames, modsTable) {
  const order = ["Overbarrel", "Underbarrel", "Chassis"];
  const slotsByMod = {};
  for (const m of modsTable) (slotsByMod[m.Modification] ??= new Set()).add(m.Slot);
  const entries = (modNames || [])
    .map(name => ({ name, candidates: order.filter(s => (slotsByMod[name] || new Set()).has(s)) }))
    .filter(e => e.candidates.length > 0);
  const assigned = {}, overflow = [];
  for (const flexible of [false, true]) {
    for (const e of entries) {
      if ((e.candidates.length > 1) !== flexible) continue;
      const slot = e.candidates.find(s => !assigned[s]);
      if (slot) assigned[slot] = e.name;
      else overflow.push(e.name);
    }
  }
  return { assigned, overflow };
}

function priceWeapons(character, data, gearCostMultiplier, warnings, strength) {
  const priced = [];
  let totalCost = 0.0, totalWeight = 0.0;
  // Smartlink grants +1 Accuracy die to any smart-capable gun.
  const hasSmartlink = (character.augments || []).some(a => a.name === "Smartlink");
  for (const entry of character.weapons) {
    const row = findRow(data.weapons, "Weapon", entry.name);
    if (!row) continue;
    // Thrown weapons stack (buy several of the same); everything else is one.
    const qty = row.Type === "Thrown" ? Math.max(1, toInt(asNumber(entry.qty, 1))) : 1;
    const baseCost = asNumber(row.Cost);
    // Integrated-smart weapons (data column "Integrated Smart") are always
    // smart at no extra cost; only opt-in smart pays the multiplier.
    const integratedSmart = Boolean(row["Integrated Smart"]);
    let cost = baseCost
      * (entry.smart && !integratedSmart ? SMART_WEAPON_COST_MULTIPLIER : 1);

    const fittedMods = [];
    let accMod = 0;
    for (const modName of entry.mods || []) {
      const modRow = findRow(data.weapon_mods, "Modification", modName);
      if (modRow) {
        cost += asNumber(modRow.Cost);
        accMod += asNumber(modRow.AccMod);
        fittedMods.push({ name: modName, slot: modRow.Slot, effect: modRow.Effect });
      }
    }
    // The same mod can't be fitted twice (e.g. two Laser Sights).
    const seenMods = new Set();
    for (const mod of fittedMods) {
      if (seenMods.has(mod.name)) {
        warnings.push(`${entry.name}: ${mod.name} fitted more than once.`);
      }
      seenMods.add(mod.name);
    }
    // One mod per slot (Overbarrel / Underbarrel / Chassis). Dual-slot mods
    // land in whichever of their slots is free; any mod left without a free
    // slot is flagged.
    const { overflow } = assignWeaponModSlots(fittedMods.map(m => m.name), data.weapon_mods);
    for (const name of overflow) {
      warnings.push(`${entry.name}: no free slot for ${name} — one Overbarrel, `
        + "one Underbarrel, and one Chassis mod per weapon.");
    }

    cost = round2(cost * gearCostMultiplier * qty);
    totalCost += cost;
    totalWeight += asNumber(row.Weight) * qty;
    const item = {};
    for (const col of ["Type", "Weapon", "Accuracy", "Reach", "Damage", "Firing modes",
                       "Ammo", "Pen", "Conceal", "Weight", "Hardening", "Notes"]) {
      item[col] = row[col] !== undefined ? row[col] : "";
    }
    if (row.Type === "Melee") item.Damage = meleeDamage(row, strength);
    item.smart = Boolean(entry.smart) || integratedSmart;
    // Accuracy: base + fitted-mod AccMod (Laser Sight / Red dot +1, Silencer −2)
    // + Smartlink (+1 on smart guns). Melee weapons carry no Accuracy value.
    if (item.Accuracy !== "" && item.Accuracy != null) {
      let acc = toInt(asNumber(item.Accuracy)) + toInt(accMod);
      if (item.smart && hasSmartlink) { acc += 1; item.smartlink = true; }
      item.Accuracy = String(acc);
    }
    item.qty = qty;
    item.mods = fittedMods;
    item.Ammo = applyExtendedMagazine(item.Ammo, fittedMods);
    item.cost = cost;
    item.equipped = entry.equipped !== false;
    priced.push(item);
  }
  return { items: priced, cost: totalCost, weight: totalWeight };
}

/**
 * Melee weapon damage: table Damage is a base value; a share of the wielder's
 * Strength (rounded down) is added — half by default, or the weapon's
 * "STR Mult" (e.g. Power Fist uses 1 for full Strength) — then any
 * "Damage Bonus" notation (e.g. Plasma weapons' "+2d6") is appended as-is.
 */
function meleeDamage(row, strength) {
  const mult = row["STR Mult"] !== undefined && row["STR Mult"] !== ""
    ? asNumber(row["STR Mult"]) : 0.5;
  return String(toInt(asNumber(row.Damage)) + Math.floor(strength * mult))
    + (row["Damage Bonus"] || "");
}

/**
 * Extended Magazine mod: base ammo + 2 + 20% of base (the percentage part is at
 * least 1). Non-numeric ammo (melee, blank) is returned unchanged. `mods` is the
 * list of fitted-mod objects ({name,...}) or plain mod-name strings.
 */
function applyExtendedMagazine(ammo, mods) {
  const hasExtMag = (mods || []).some(m =>
    (typeof m === "string" ? m : m && m.name) === "Extended Magazine");
  if (!hasExtMag) return ammo;
  const base = toInt(asNumber(ammo, NaN));
  if (!Number.isFinite(base) || String(ammo).trim() === "") return ammo;
  return base + 2 + Math.max(1, Math.floor(base * 0.2));
}

function priceArmor(character, data, gearCostMultiplier, warnings) {
  const styleMultiplier = {}, materialMultiplier = {}, extraMultiplier = {};
  // Quality/Style also carry gameplay effects (Charisma tests, Etiquette
  // bonuses) that the Gear and Overview tabs display alongside the piece.
  const styleEffect = {}, materialEffect = {}, extraEffect = {};
  for (const row of data.armor_styles) {
    styleMultiplier[row.Style] = asNumber(row.Multiplier, 1);
    styleEffect[row.Style] = row["Etiquette Bonus"] || "";
  }
  for (const row of data.armor_materials) {
    materialMultiplier[row.Material] = asNumber(row.Multiplier, 1);
    materialEffect[row.Material] = row.Effect || "";
  }
  for (const row of data.armor_extras) {
    extraMultiplier[row.Extra] = asNumber(row.Multiplier, 1);
    extraEffect[row.Extra] = row.Effects || "";
  }

  const priced = [];
  let totalCost = 0.0, totalWeight = 0.0;
  let totalBallistic = 0, totalImpact = 0, maxBallistic = 0;
  const activePiecesBySlot = {};

  for (const entry of character.armor) {
    const row = findRow(data.armor, "Armor", entry.name);
    if (!row) continue;
    let cost = asNumber(row.Cost);
    // Each multiplier applies to the BASE cost: its surcharge is base ×
    // (mult − 1), and surcharges add — they never compound on the running
    // total. (Matches the play-mode extras pricing in sheet.js.)
    // Quality (the armor_materials scale) applies to EVERY armor piece; Style
    // and Extras are cosmetic and only apply to styleable pieces (Style = Y).
    const base = cost;
    const surcharge = mult => base * ((mult !== undefined ? mult : 1) - 1);
    cost += surcharge(materialMultiplier[entry.material]);
    if (row.Style === "Y") {
      cost += surcharge(styleMultiplier[entry.style]);
      for (const extraName of entry.extras || []) {
        cost += surcharge(extraMultiplier[extraName]);
      }
    }
    cost = round2(cost * gearCostMultiplier);

    totalCost += cost;
    totalWeight += asNumber(row.wt);
    const isActive = entry.active === undefined ? true : Boolean(entry.active);
    if (isActive) {
      const slot = row.Slot || "";
      if (slot === "Outer" || slot === "Under") {
        activePiecesBySlot[slot] = (activePiecesBySlot[slot] || 0) + 1;
      }
      const pieceBallistic = toInt(asNumber(row.Ballistic));
      totalBallistic += pieceBallistic;
      if (pieceBallistic > maxBallistic) maxBallistic = pieceBallistic;
      totalImpact += toInt(asNumber(row.Impact));
    }

    const item = {};
    for (const col of ["Armor", "Ballistic", "Impact", "wt", "Slot"]) {
      item[col] = row[col] !== undefined ? row[col] : "";
    }
    // Style/Extras only exist on styleable pieces, so blank them out on the
    // rest -- a stale value from an earlier edit must not show as applied.
    const styleable = row.Style === "Y";
    item.styleable = styleable;
    item.style = styleable ? (entry.style || "") : "";
    item.material = entry.material || "";
    item.extras = styleable ? (entry.extras || []) : [];
    // Gameplay effects of the chosen Quality / Style / Extras, labelled for
    // display. "No Bonus" and blanks are dropped -- nothing to report.
    const effects = [];
    const addEffect = (label, text) => {
      const t = (text || "").trim();
      if (t && !/^no bonus$/i.test(t)) effects.push({ label, text: t });
    };
    addEffect(item.material, materialEffect[item.material]);
    addEffect(item.style, styleEffect[item.style]);
    for (const extraName of item.extras) addEffect(extraName, extraEffect[extraName]);
    item.effects = effects;
    item.active = isActive;
    item.cost = cost;
    priced.push(item);
  }

  for (const [slot, count] of Object.entries(activePiecesBySlot)) {
    if (count > 1) warnings.push(`More than one ${slot} armor piece is active.`);
  }

  return { items: priced, cost: totalCost, weight: totalWeight,
           ballistic_armor: totalBallistic, impact_armor: totalImpact,
           ballistic_armor_max: maxBallistic };
}

function priceDecking(character, data, gearCostMultiplier, warnings) {
  const hackingRating = Math.max(0, toInt(asNumber(character.hacking_rating)));
  let deckCost = 0.0;
  for (const entry of character.decks) {
    const row = findRow(data.decks, "Name", entry.name);
    if (!row) continue;
    let cost = asNumber(row.Cost);
    const slotCapacity = toInt(asNumber(row.Mods));
    let slotsUsed = 0;
    for (const modName of entry.mods || []) {
      const modRow = findRow(data.deck_mods, "Deck Mod", modName);
      if (modRow) {
        cost += asNumber(modRow.Cost);
        slotsUsed += toInt(asNumber(modRow.Slots, 1));
      }
    }
    if (slotsUsed > slotCapacity) {
      warnings.push(`${entry.name}: deck mod slots exceeded `
                    + `(${slotsUsed}/${slotCapacity}).`);
    }
    const requiredHacking = Math.max(1, Math.floor(toInt(asNumber(row.MCP)) / 2));
    if (hackingRating < requiredHacking) {
      warnings.push(
        `${entry.name}: needs a Hacking program rating of `
        + `${requiredHacking} (½ MCP) — currently ${hackingRating}.`);
    }
    deckCost += round2(cost * gearCostMultiplier);
  }

  const programCost = round2(sumBy(character.programs, name =>
    asNumber((findRow(data.programs, "Name", name) || {}).Cost)) * gearCostMultiplier);
  const hackingCost = round2(hackingRating * HACKING_RATING_COST * gearCostMultiplier);

  return { cost: deckCost + programCost + hackingCost,
           hacking_rating: hackingRating, hacking_cost: hackingCost };
}

/**
 * Effective VCR stats after fitted rig mods are applied. Bonus Link raises Links,
 * Input Validation / Military Grade Hardening raise Hardening, etc. Returns base
 * values (from the rig row) plus mod contributions, and mod-slot usage.
 */
function rigStats(rigEntry, data) {
  const row = findRow(data.rigs, "Rig Type", rigEntry.name) || {};
  let links = toInt(asNumber(row.Links));
  let hardening = toInt(asNumber(row.Hardening));   // stored like "+0"/"+1"; asNumber parses the sign
  let bonusDice = toInt(asNumber(row["Bonus Dice"]));
  const modSlots = toInt(asNumber(row.Mods));
  let modSlotsUsed = 0;
  for (const modName of rigEntry.mods || []) {
    const modRow = findRow(data.rig_mods, "Rig Mod", modName);
    if (!modRow) continue;
    modSlotsUsed += Math.max(1, toInt(asNumber(modRow.Slots, 1)));
    links += toInt(asNumber(modRow.Link));
    hardening += toInt(asNumber(modRow.Hardening));
    bonusDice += toInt(asNumber(modRow["Bonus Dice"]));
  }
  return { row, links, hardening, bonusDice, cores: row.Cores || "",
           modSlots, modSlotsUsed };
}

function priceRig(character, data, gearCostMultiplier, warnings) {
  let totalCost = 0.0;
  for (const entry of character.rigs) {
    const row = findRow(data.rigs, "Rig Type", entry.name);
    if (!row) continue;
    let cost = asNumber(row.Cost);
    for (const modName of entry.mods || []) {
      const modRow = findRow(data.rig_mods, "Rig Mod", modName);
      if (modRow) cost += asNumber(modRow.Cost);
    }
    const stats = rigStats(entry, data);
    if (warnings && stats.modSlotsUsed > stats.modSlots) {
      warnings.push(`${entry.name}: ${stats.modSlotsUsed} mod slot(s) used but only `
                    + `${stats.modSlots} available.`);
    }
    totalCost += round2(cost * gearCostMultiplier);
  }
  return { cost: totalCost };
}

const HEAVY_FITTING_WEIGHT = 4;
const CARGO_PER_WEIGHT_BLOCK = 3;
const VEHICLE_MIN_CARGO = 1;
const VEHICLE_WEAPON_BODY_DIVISOR = 3;
// Vehicle Condition scales the base price (not fitted weapons/mods).
const VEHICLE_CONDITIONS = ["Pristine", "Good", "Fair", "Poor"];
const VEHICLE_CONDITION_FACTORS = { Pristine: 1, Good: 0.75, Fair: 0.5, Poor: 0.25 };

function priceFittedVehicle(entry, baseRow, data, weaponAndModTables, gearCostMultiplier) {
  // Vehicle Condition AND the small-heritage surcharge scale the BASE price
  // only — fitted weapons/mods always pay face value. Drones have no condition
  // field and pass gearCostMultiplier 1, so both are no-ops for them.
  let cost = asNumber(baseRow.Cost) * (VEHICLE_CONDITION_FACTORS[entry.condition] || 1)
             * gearCostMultiplier;
  const fitted = [];
  // Unit mods may be plain names (unit-scoped) or {name, weapon} (attached to a
  // specific mounted weapon); either way we price by the mod's name.
  const fittedNames = [...(entry.weapons || []),
    ...(entry.mods || []).map(m => (typeof m === "string" ? m : m && m.name))];
  for (const requestedName of fittedNames) {
    if (!requestedName) continue;
    for (const [dataKey, nameColumn] of weaponAndModTables) {
      const found = findRow(data[dataKey], nameColumn, requestedName);
      if (found) {
        cost += asNumber(found.Cost);
        fitted.push({ name: requestedName,
                      weight: asNumber(found.Weight),
                      is_weapon: !dataKey.includes("mods") });
        break;
      }
    }
  }
  cost = round2(cost);
  const summary = { name: entry.name, fitted: fitted.map(f => f.name),
                    fitted_detail: fitted, cost };
  for (const field of ["Move", "Body", "Handling", "Frame", "Cargo", "Impact",
                       "Ballistic", "Effect", "WW", "Hard Point"]) {
    if (field in baseRow) summary[field] = baseRow[field];
  }
  return [cost, summary];
}

function checkVehicleLimits(summary, warnings) {
  const fitted = summary.fitted_detail || [];
  const heavy = fitted.filter(f => f.weight > HEAVY_FITTING_WEIGHT);
  const normalWeight = sumBy(fitted, f => f.weight <= HEAVY_FITTING_WEIGHT ? f.weight : 0);
  const cargoLoss = Math.floor(toInt(normalWeight) / CARGO_PER_WEIGHT_BLOCK) + 2 * heavy.length;
  const baseCargo = toInt(asNumber(summary.Cargo));
  summary.effective_cargo = baseCargo - cargoLoss;
  if (summary.effective_cargo < VEHICLE_MIN_CARGO) {
    warnings.push(`${summary.name}: fitted weight leaves ${summary.effective_cargo} `
                  + `Cargo — a vehicle needs at least ${VEHICLE_MIN_CARGO} for the driver.`);
  }

  const weaponCount = fitted.filter(f => f.is_weapon).length;
  const weaponCap = Math.floor(toInt(asNumber(summary.Body)) / VEHICLE_WEAPON_BODY_DIVISOR);
  summary.weapon_count = weaponCount;
  summary.weapon_cap = weaponCap;
  if (weaponCount > weaponCap) {
    warnings.push(`${summary.name}: ${weaponCount} weapons mounted — `
                  + `max is ${weaponCap} (Body ÷ 3).`);
  }
}

function checkDroneLimits(summary, warnings) {
  const fitted = summary.fitted_detail || [];
  const totalWeight = sumBy(fitted, f => f.weight);
  const ww = toInt(asNumber(summary.WW));
  summary.ww_used = totalWeight;
  summary.ww_max = ww;
  if (totalWeight > ww) {
    // %g-style formatting to match the Python reference exactly
    warnings.push(`${summary.name}: fitted weight ${Number(totalWeight.toPrecision(6))} exceeds WW ${ww}.`);
  }

  const weaponCount = fitted.filter(f => f.is_weapon).length;
  const hardPoints = toInt(asNumber(summary["Hard Point"]));
  summary.weapon_count = weaponCount;
  summary.weapon_cap = hardPoints;
  if (weaponCount > hardPoints) {
    warnings.push(`${summary.name}: ${weaponCount} weapons mounted — `
                  + `only ${hardPoints} hard point(s).`);
  }
}

function priceDronesAndVehicles(character, data, gearCostMultiplier, warnings) {
  const droneTables = [["drone_ballistic_weapons", "Drone Ballistic Weapon"],
                       ["drone_energy_weapons", "Drone Energy Weapon"],
                       ["drone_mods", "Drone Mod"]];
  const vehicleTables = [["vehicle_ballistic_weapons", "Vehicle Ballistic Weapon"],
                         ["vehicle_energy_weapons", "Vehicle Energy Weapon"],
                         ["vehicle_mods", "Vehicle Mod"]];

  const priceAll = (entries, tableKey, nameColumn, weaponTables, check, mult) => {
    let total = 0.0;
    const summaries = [];
    for (const entry of entries) {
      const row = findRow(data[tableKey], nameColumn, entry.name);
      if (!row) continue;
      const [cost, summary] = priceFittedVehicle(entry, row, data, weaponTables, mult);
      check(summary, warnings);
      total += cost;
      summaries.push(summary);
    }
    return [total, summaries];
  };

  // The small-heritage surcharge covers a vehicle's base chassis (priceFittedVehicle
  // applies it to the base only, not fitted weapons/mods) but not drones — a
  // small pilot doesn't change a remote drone's price.
  const [droneCost, drones] = priceAll(character.drones, "drones", "Drone",
                                       droneTables, checkDroneLimits, 1);
  const [vehicleCost, vehicles] = priceAll(character.vehicles, "vehicles", "Vehicle",
                                           vehicleTables, checkVehicleLimits,
                                           surchargeFor("vehicle", gearCostMultiplier));
  return { drones, vehicles, cost: droneCost + vehicleCost };
}

function priceMiscGearAndLifestyle(character, data, gearCostMultiplier, hasHyperthyroid) {
  let gearCost = 0.0, gearWeight = 0.0;
  for (const entry of character.gear) {
    const row = findRow(data.misc_gear, "Item", entry.name);
    if (!row) continue;
    const quantity = Math.max(1, toInt(asNumber(entry.qty, 1)));
    gearCost += asNumber(row.Cost) * quantity;
    gearWeight += asNumber(row.Weight) * quantity;
  }
  gearCost = round2(gearCost * gearCostMultiplier);

  let prepaid = (character.lifestyles || []).length ? character.lifestyles : [];
  if (!prepaid.length && character.lifestyle && character.lifestyle.name) {
    prepaid = [character.lifestyle];
  }
  let lifestyleCost = 0.0;
  for (const entry of prepaid) {
    const row = findRow(data.lifestyles, "Lifestyle", entry.name) || { MonthlyCost: 0 };
    lifestyleCost += asNumber(row.MonthlyCost) * Math.max(
      0, toInt(asNumber(entry.months, 1)));
  }
  if (hasHyperthyroid) lifestyleCost *= HYPERTHYROID_LIFESTYLE_SURCHARGE;

  return { gear_cost: gearCost, gear_weight: gearWeight, lifestyle_cost: lifestyleCost };
}

// Zoetic Rating from gear reflects what's actively carried/worn/linked, not
// everything owned — matches the "carried ZR" wording in the ZP warning below.
function gearZoeticRating(character, data) {
  let total = 0.0;

  const add = (table, nameColumn, names) => {
    for (const name of names) {
      const row = findRow(data[table], nameColumn, name);
      if (row) total += asNumber(row.ZR);
    }
  };

  add("weapons", "Weapon", character.weapons
    .filter(w => w.equipped !== false).map(w => w.name));
  // Armor: base row ZR, +1 for any piece with at least one Extra fitted
  // (house rule: mods add circuitry to otherwise-inert armor).
  for (const entry of character.armor.filter(a => a.active !== false)) {
    const row = findRow(data.armor, "Armor", entry.name);
    if (row) total += asNumber(row.ZR) + ((entry.extras || []).length ? 1 : 0);
  }
  add("decks", "Name", character.decks.map(d => d.name));
  add("programs", "Name", character.programs);
  const activeRigName = (character.play && character.play.rigging
                         && character.play.rigging.active_rig) || "";
  add("rigs", "Rig Type", character.rigs
    .filter(r => r.name === activeRigName).map(r => r.name));
  add("drones", "Drone", character.drones.map(d => d.name));
  add("vehicles", "Vehicle", character.vehicles.map(v => v.name));
  return round2(total);
}

// The character's single "active" deck/rig drives its exploit-action count (you
// can only jack into one deck / pilot one rig at a time). Falls back to the first
// owned item when nothing is flagged active yet, mirroring the play-tab default.
function activeGearRow(owned, activeName, table, keyCol) {
  if (!owned || !owned.length) return null;
  let name = activeName;
  if (!name || !owned.some(o => o.name === name)) name = owned[0].name;
  return findRow(table, keyCol, name) || null;
}

// Every exploit action the character can bring to bear, itemised by kind and
// source, for the Overview combat card. See rules #1–7 in the changelog:
// Wired Reflexes / Combat Mastery (Melee), Trackmobi / Repulsors (Move), the
// active Deck / Rig's cores (Decking / Rigging), and summon spells / slotted
// bond spirits (Control).
function deriveExploitActions(character, data, magicType, augments, amp) {
  const actions = [];   // [{ kind, count, source }]

  // --- Melee: Wired Reflexes (1 or 2 by rank) + Combat Mastery amp (+2).
  if (augments.melee_exploit_bonus > 0) {
    actions.push({ kind: "Melee", count: augments.melee_exploit_bonus,
      source: augments.wired_reflexes_rank
        ? `Wired Reflexes ${augments.wired_reflexes_rank}` : "Wired Reflexes" });
  }
  if (amp.powers_taken.has("Combat Mastery")) {
    actions.push({ kind: "Melee", count: COMBAT_MASTERY_MELEE_EXPLOIT_BONUS,
      source: "Combat Mastery (Amp)" });
  }

  // --- Move: each Trackmobi / Repulsors mount grants one.
  for (const name of augments.move_exploit_sources || []) {
    actions.push({ kind: "Move", count: 1, source: name });
  }

  // --- Decking: the active deck's cores (Single 1 … Quad 4).
  const deck = activeGearRow(character.decks,
    ((character.play || {}).decking || {}).active_deck, data.decks, "Name");
  if (deck) {
    const n = CORE_EXPLOIT_COUNT[deck.Core] || 0;
    if (n) actions.push({ kind: "Decking", count: n,
      source: `${deck.Name} (${deck.Core} core)` });
  }

  // --- Rigging: the active rig's cores, same scale as decks.
  const rig = activeGearRow(character.rigs,
    ((character.play || {}).rigging || {}).active_rig, data.rigs, "Rig Type");
  if (rig) {
    const n = CORE_EXPLOIT_COUNT[rig.Cores] || 0;
    if (n) actions.push({ kind: "Rigging", count: n,
      source: `${rig["Rig Type"]} (${rig.Cores} core)` });
  }

  // --- Control: one per summon spell known (Mage/Archmage) …
  if (magicType === "Mage" || magicType === "Archmage") {
    const known = new Set((character.magic.spells || []).map(s => s.name));
    for (const spellName of SUMMON_CONTROL_SPELLS) {
      if (known.has(spellName)) actions.push({ kind: "Control", count: 1, source: spellName });
    }
  }
  // … and two per spirit slotted in a Speaker/Archmage bond slot (play state).
  if (magicType === "Speaker" || magicType === "Archmage") {
    for (const bond of (character.play || {}).bond_slots || []) {
      if (bond && bond.spirit) actions.push({ kind: "Control",
        count: SPEAKER_BOND_CONTROL_EXPLOITS, source: bond.spirit });
    }
  }

  return actions;
}

// ============================================================== step 9: combat stats
function deriveCombatStats(heritage, finalAttributes, augments, amp, weaponWeight,
                           armorWeight, gearWeight, cyberwareZoeticRating,
                           armorBallistic, armorImpact, armorBallisticMax) {
  const isReplicant = heritage.type === "Replicant";
  const conditionBonus = isReplicant ? REPLICANT_CONDITION_BONUS : 0;
  // 1/2 attribute rounds down but never below 1, then +6 base track.
  const physicalCondition = (CONDITION_TRACK_BASE
                             + Math.max(1, Math.floor(finalAttributes.Body / 2)) + conditionBonus);
  const stunCondition = (CONDITION_TRACK_BASE
                         + Math.max(1, Math.floor(finalAttributes.Willpower / 2)) + conditionBonus);

  const hasChelonian = amp.powers_taken.has("Aspect of the Chelonian");
  // Perfect Situational Awareness grants +3d on dodge AND soak — fold it into
  // both combat bonuses (it was previously only a Brawn pool note).
  const psaBonus = amp.powers_taken.has("Perfect Situational Awareness")
    ? PERFECT_SITUATIONAL_AWARENESS_BONUS : 0;
  // Itemised non-worn armor (cyber/bioware augments, innate heritage, amp) so
  // the Overview loadout can list each source, not just the combined total.
  const armorSources = [];
  for (const [row, count] of augments.rows) {
    const b = toInt(asNumber(row["Ballistic Armor"])) * count;
    const i = toInt(asNumber(row["Impact Armor"])) * count;
    if (b || i) armorSources.push({ name: row.Name, b, i,
      unstrippable: !!toInt(asNumber(row.ImpArmMin)) });
  }
  if (heritage.ballistic_armor || heritage.impact_armor)
    armorSources.push({ name: "Innate (heritage)", b: heritage.ballistic_armor,
      i: heritage.impact_armor, unstrippable: true });
  if (hasChelonian)
    armorSources.push({ name: "Aspect of the Chelonian", b: CHELONIAN_BALLISTIC_ARMOR,
      i: CHELONIAN_IMPACT_ARMOR });
  const simpleActions = amp.powers_taken.has("Adrenaline Boost")
    ? ADRENALINE_BOOST_SIMPLE_ACTIONS : DEFAULT_SIMPLE_ACTIONS;

  const isSynthetic = heritage.type === "Synthetic";
  let carriedWeight = weaponWeight + armorWeight + gearWeight;
  if (!isSynthetic) carriedWeight += cyberwareZoeticRating;

  return {
    physical: physicalCondition,
    stun: stunCondition,
    move: BASE_MOVE_METERS + heritage.move_bonus + augments.move_bonus,
    // Mobi augments now surface as structured move_modes; keep heritage quirks here.
    move_special: [...heritage.special_move_notes],
    // Recoil capacity: Strength + Gyromount(+2 each). Fitted weapon mods
    // (Bi-pod, Gas Vent) and the Cybergun's doubled Strength add on top per-gun.
    recoil_capacity: finalAttributes.Strength + augments.recoil_capacity_bonus,
    optics_notes: augments.combat_notes,
    sense_notes: augments.sense_notes,
    move_modes: augments.move_modes,
    physical_damage_reduction: augments.physical_damage_reduction,
    simple_actions: simpleActions,
    ballistic_armor: (armorBallistic + augments.ballistic_armor
                      + heritage.ballistic_armor
                      + (hasChelonian ? CHELONIAN_BALLISTIC_ARMOR : 0)),
    impact_armor: (armorImpact + augments.impact_armor
                   + heritage.impact_armor
                   + (hasChelonian ? CHELONIAN_IMPACT_ARMOR : 0)),
    armor_sources: armorSources,
    // Highest single ballistic source (armor doesn't stack for this cap).
    max_ballistic: Math.max(armorBallisticMax || 0, augments.ballistic_armor_max || 0,
                            heritage.ballistic_armor_max || 0,
                            hasChelonian ? CHELONIAN_BALLISTIC_ARMOR : 0),
    // Impact armor that can't be stripped: un-strippable augments + innate heritage.
    min_impact: (augments.impact_armor_min || 0) + (heritage.impact_armor || 0),
    dodge_bonus: heritage.dodge_bonus + augments.dodge_bonus + psaBonus,
    soak_bonus: heritage.soak_bonus + psaBonus,
    carried_weight: round2(carriedWeight),
  };
}

function deriveInitiative(pools, finalAttributes, heritage, augments, amp, martialArt, data) {
  const notes = [];

  const scan = (label, text) => {
    if (text && text.toLowerCase().includes("initiat")) notes.push(`${label}: ${text}`);
  };

  for (const row of heritage.traits) scan(row.Name, row.Effects || "");
  for (const [row] of augments.rows) scan(row.Name, row.Effect || "");
  for (const name of amp.powers_taken) {
    const row = findRow(data.amp_powers, "Name", name);
    if (row) scan(name, row.Effect || "");
  }
  for (const level of martialArt.levels) {
    scan(`${level.Style || martialArt.style} L${level.Level}`, level.Effect || "");
  }
  return { dice: pools.Focus, bonus: finalAttributes.Reaction, notes };
}

const ADRENAL_PUMP_POOLS = ["Brawn", "Finesse", "Resolve"];

function derivePoolNotes(heritage, augments, amp, martialArt) {
  const notes = {};
  for (const pool of POOL_NAMES) notes[pool] = [];
  if (heritage.soak_bonus) {
    notes.Brawn.push(`+${heritage.soak_bonus}d Soak (heritage)`);
  }
  const traitNames = new Set(heritage.traits.map(row => row.Name));
  if (traitNames.has("Unstoppable")) {
    notes.Brawn.push("Reroll 1s on Soak (Unstoppable)");
  }
  if (traitNames.has("Wildling")) {
    notes.Brawn.push("+6 in man-beast form (Wildling)");
    notes.Finesse.push("+6 in man-beast form (Wildling)");
    notes.Focus.push("−3 in man-beast form (Wildling)");
    notes.Resolve.push("−3 in man-beast form (Wildling)");
  }
  if (heritage.specialization_pool in notes) {
    notes[heritage.specialization_pool].push("+1d to all tests (Specialization)");
  }
  const ownedNames = new Set(augments.rows.map(([row]) => row.Name));
  if (ownedNames.has("Hyper Adrenal Pump")) {
    for (const pool of ADRENAL_PUMP_POOLS) notes[pool].push("+4 while Hyper Adrenal Pump active");
  } else if (ownedNames.has("Adrenal Pump")) {
    for (const pool of ADRENAL_PUMP_POOLS) notes[pool].push("+2 while Adrenal Pump active");
  }
  if (amp.powers_taken.has("Perfect Situational Awareness")) {
    notes.Brawn.push("+3d dodge/soak/resistance (Perfect Situational Awareness)");
  }
  // Escalating soak tiers replace each other, so show the single effective bonus
  // (computed in martialArtStatMods) rather than one note per unlocked tier.
  if (martialArt.mods && martialArt.mods.soak_bonus)
    notes.Brawn.push(`+${martialArt.mods.soak_bonus}d Soak (${martialArt.style})`);
  return notes;
}

/**
 * Parse the cumulative unlocked levels of a martial art for the effects that map
 * to a tracked numeric stat, so they can be applied (not just shown as text):
 *   - Dodge dice  (Weirding Way +1d→+2d)  — escalating tiers *replace*, take best
 *   - Soak dice   (Shibumi +1d→+6d)       — escalating tiers *replace*, take best
 *   - Movement    (Weirding Way +2m base)  — additive metres
 *   - Recoil      (Gun-Kata "Ignore Recoil") — flag
 *   - Unarmed dmg (Shibumi "Unarmed deals Str+N") — surfaced as a note
 *   - Spurs dmg   (Way of the Tank "Spurs do N+STR") — overrides spur damage
 * Conditional dodge ("+4d vs 1 Tgt") is left as flavour text, not a flat bonus.
 */
function martialArtStatMods(levels) {
  const mods = { dodge_bonus: 0, soak_bonus: 0, move_bonus: 0,
    recoil_ignored: false, unarmed_damage: "", spurs_str_bonus: null, applied: [] };
  for (const lvl of levels) {
    const eff = lvl.Effect || "";
    let m = eff.match(/([+-]?\d+)\s*d\b[^.]*?\bdodge\b/i);
    if (m && !/\b(vs|if)\b/i.test(eff)) mods.dodge_bonus = Math.max(mods.dodge_bonus, toInt(m[1]));
    m = eff.match(/([+-]?\d+)\s*d\b[^.]*?\bsoak\b/i);
    if (m) mods.soak_bonus = Math.max(mods.soak_bonus, toInt(m[1]));
    m = eff.match(/([+-]?\d+)\s*m\b[^.]*?mov/i);
    if (m) mods.move_bonus += toInt(m[1]);
    if (/ignore\s+recoil/i.test(eff)) mods.recoil_ignored = true;
    m = eff.match(/unarmed[^.]*?str\s*\+\s*(\d+)/i);
    if (m) mods.unarmed_damage = `STR+${m[1]}`;
    m = eff.match(/spurs?[^.]*?(\d+)\s*\+\s*str/i);
    if (m) mods.spurs_str_bonus = toInt(m[1]);
  }
  if (mods.dodge_bonus) mods.applied.push(`+${mods.dodge_bonus}d Dodge`);
  if (mods.soak_bonus) mods.applied.push(`+${mods.soak_bonus}d Soak`);
  if (mods.move_bonus) mods.applied.push(`+${mods.move_bonus}m Movement`);
  if (mods.recoil_ignored) mods.applied.push("Recoil ignored");
  if (mods.unarmed_damage) mods.applied.push(`Unarmed ${mods.unarmed_damage} physical`);
  if (mods.spurs_str_bonus != null) mods.applied.push(`Spurs STR+${mods.spurs_str_bonus}`);
  return mods;
}

// Resolve each of the character's martial-art styles to its unlocked levels +
// stat mods. Returns a list of { style, rank, levels, mods }.
function resolveMartialArts(character, data) {
  const seen = new Set();
  const list = [];
  for (const ma of character.martial_arts || []) {
    const style = (ma.style || "").trim();
    if (!style || seen.has(style)) continue;   // ignore blanks / duplicate styles
    seen.add(style);
    const rank = Math.max(0, Math.min(SKILL_RANK_CAP, toInt(asNumber(ma.rank))));
    const levels = data.martial_arts.filter(row =>
      row.Style === style && toInt(asNumber(row.Level)) <= rank);
    list.push({ style, rank, levels, mods: martialArtStatMods(levels) });
  }
  return list;
}

// Fold the per-style list into one object shaped like the old single martial
// art, so combat / initiative / pool-note consumers keep working unchanged.
// Cross-style stat bonuses combine via martialArtStatMods on the union of all
// unlocked levels (max for dodge/soak, sum for movement).
function aggregateMartialArts(list) {
  const levels = list.flatMap(a => a.levels);
  const styles = list.map(a => a.style);
  return { style: styles.join(", "), styles, list, levels,
    rank: maxOf(list.map(a => a.rank), 0), mods: martialArtStatMods(levels) };
}

// ============================================================== play mode (post-finalize)
function deepCopy(value) {
  return (typeof structuredClone === "function")
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function applyPlayAdvances(character) {
  character = deepCopy(character);
  const play = character.play || {};
  for (const [name, plus] of Object.entries(play.attribute_advances || {})) {
    if (name in character.attributes) {
      character.attributes[name] =
        toInt(asNumber(character.attributes[name], 1)) + toInt(asNumber(plus));
    }
  }
  for (const [name, plus] of Object.entries(play.skill_advances || {})) {
    if (name in SKILLS) {
      character.skills[name] =
        toInt(asNumber(character.skills[name] || 0)) + toInt(asNumber(plus));
    }
  }
  // Martial-art ranks bought in play, per style. Raising an existing style adds
  // to its rank; a style first learned in play is appended.
  character.martial_arts = character.martial_arts || [];
  for (const [style, plus] of Object.entries(play.martial_art_advances || {})) {
    const add = toInt(asNumber(plus));
    if (!style || add === 0) continue;
    const entry = character.martial_arts.find(m => m.style === style);
    if (entry) entry.rank = toInt(asNumber(entry.rank)) + add;
    else character.martial_arts.push({ style, rank: add });
  }
  for (const [name, plus] of Object.entries(play.ritual_advances || {})) {
    character.ritual_skills[name] =
      toInt(asNumber(character.ritual_skills[name] || 0)) + toInt(asNumber(plus));
  }
  const purchases = play.purchases || {};
  character.gear.push(...(purchases.gear || []));
  character.augments.push(...(purchases.augments || []));
  character.magic.amp_powers.push(...(purchases.amp_powers || []));
  character.magic.spells.push(...(purchases.spells || []));
  character.hacking_rating = (toInt(asNumber(character.hacking_rating))
                              + toInt(asNumber(purchases.hacking_levels)));
  for (const [name, plus] of Object.entries(play.spell_force_advances || {})) {
    for (const spell of character.magic.spells) {
      if (spell.name === name) {
        spell.force = toInt(asNumber(spell.force)) + toInt(asNumber(plus));
        break;
      }
    }
  }
  return character;
}

// ============================================================== orchestrator
function calculate(character) {
  character = mergeDefaults(character);
  activeHouseRules = normalizeHouseRules(character);   // this character's house rules drive houseRule()
  const finalized = Boolean(character.finalized);
  if (finalized) character = applyPlayAdvances(character);
  const data = loadData();
  syncEngineeringSkills();   // reshape Engineering skills per the house rule
  syncEWSkill();             // add/remove Computer: Electronic Warfare per the EW rule
  const warnings = [], errors = [];

  const priorities = resolvePriorities(character, data, warnings, errors);
  const magicType = priorities.magic_type;

  const heritage = applyHeritage(character, data, warnings, errors);
  if (finalized) {
    heritage.zoetic_potential += toInt(asNumber(
      (character.play || {}).zp_advances));
  }
  const augments = tallyAugments(character, data, warnings, errors);
  mergeMountedAugments(augments,
                       tallyMountedAugments(character, data, warnings, errors));
  const amp = tallyAmpPowers(character, data, magicType, warnings, errors);

  let replicantAttrBonus = 0, replicantSkillBonus = 0;
  if (character.heritage.type === "Replicant") {
    replicantAttrBonus = REPLICANT_BONUS_ATTRIBUTE_POINTS;
    replicantSkillBonus = REPLICANT_BONUS_SKILL_POINTS;
  }

  const attributeScoring = scoreAttributes(
    character, data, priorities.starting_attr_pts + replicantAttrBonus,
    heritage, augments, amp, warnings, errors);
  const finalAttributes = attributeScoring.final;

  const pools = computePools(finalAttributes, character.cha_pool_choice || "Brawn");
  // Permanent Kismet-die major boons add to a pool (finalized play only).
  if (finalized && character.play && character.play.pool_kismet) {
    for (const [pool, n] of Object.entries(character.play.pool_kismet)) {
      if (pool in pools) pools[pool] += toInt(asNumber(n));
    }
  }

  const skillScoring = scoreSkills(character, heritage, amp, augments, warnings, errors);
  skillScoring.points.budget = priorities.starting_skill_pts + replicantSkillBonus;
  skillScoring.points.remaining =
    skillScoring.points.budget - skillScoring.points.spent;
  if (skillScoring.points.remaining < 0) {
    errors.push(`Skill points overspent by ${-skillScoring.points.remaining}.`);
  }

  // Bonus skill dice from active + linked drones (shown as "rank+Nd").
  const skillDice = droneSkillDice(character, data);
  for (const [name, dice] of Object.entries(skillDice)) {
    if (skillScoring.skills[name]) skillScoring.skills[name].dice_bonus = dice;
  }

  const knowledgeScoring = scoreKnowledgeSkills(
    character, finalAttributes.Intelligence, finalAttributes.Charisma,
    augments.knowledge_points_bonus, warnings, errors);
  const knowledge = knowledgeScoring.knowledge;
  const etiquettePoints = knowledgeScoring.etiquettes;

  const boostedInt = (augments.attribute_adjustment.Intelligence
                      + amp.attribute_adjustment.Intelligence);
  const boostedCha = (augments.attribute_adjustment.Charisma
                      + amp.attribute_adjustment.Charisma);
  if (boostedInt > 0 && knowledge.remaining > 0) {
    warnings.push(`An augment/power raised Intelligence (+${boostedInt}): your Knowledge `
                  + `pool grew — ${knowledge.remaining} point(s) unspent on the `
                  + "Knowledge & Etiquette tab.");
  }
  if (boostedCha > 0 && etiquettePoints.remaining > 0) {
    warnings.push(`An augment/power raised Charisma (+${boostedCha}): your Etiquette `
                  + `pool grew — ${etiquettePoints.remaining} point(s) unspent on the `
                  + "Knowledge & Etiquette tab.");
  }

  const magicBudget = budgetMagic(character, data, magicType, warnings, errors);

  const bodyIndexOk = augments.body_index <= finalAttributes.Body;
  if (!bodyIndexOk) {
    errors.push("Too Many Biomods: Body Index exceeds Body.");
  }

  // Small-heritage surcharge applies to physical kit only (see surchargeFor):
  // Weapons, Armor, Vehicles and cybertechtronic Augments pay it; Bioware,
  // Drones, Rigs, Decks/Programs, Gear and Lifestyle pay face value.
  const gearCostMultiplier = heritage.gear_cost_multiplier;
  // Extra Arm / Extra Leg surcharge armor only, on top of any small-heritage one.
  const armorCostMultiplier = heritage.armor_cost_multiplier || 1;
  const weapons = priceWeapons(character, data,
    surchargeFor("weapon", gearCostMultiplier), warnings, finalAttributes.Strength);
  const armor = priceArmor(character, data,
    surchargeFor("armor", gearCostMultiplier) * armorCostMultiplier, warnings);
  if (heritage.traits.some(row => row.Name === "Tough")
      && armor.items.some(item => item.Slot === "Under" && item.active)) {
    warnings.push("Tough (Blighted boon) occupies the Under armor slot — "
                  + "it doesn't stack with a worn Under armor piece.");
  }
  if (heritage.has_antlers
      && armor.items.some(item => item.Armor === "Helmet" && item.active)) {
    warnings.push("Antlers (Green bane): cannot wear helmets or headgear.");
  }
  const internalSlotOccupants = [...augments.internal_armor_slot_items];
  if (amp.powers_taken.has("Aspect of the Chelonian")) {
    internalSlotOccupants.push("Aspect of the Chelonian");
  }
  if (internalSlotOccupants.length > 1) {
    warnings.push("Internal armor slot conflict: "
                  + internalSlotOccupants.join(", ")
                  + " all occupy the internal armor slot.");
  }
  const decking = priceDecking(character, data, 1, warnings);
  const rig = priceRig(character, data, 1, warnings);
  // priceDronesAndVehicles applies the surcharge to vehicles only (drones pay
  // face value) — it splits internally, so it takes the raw multiplier.
  const vehicles = priceDronesAndVehicles(character, data, gearCostMultiplier, warnings);
  const misc = priceMiscGearAndLifestyle(character, data, 1,
                                         augments.has_hyperthyroid);
  // Cybertechtronic augments are surcharged; Bioware pays face value.
  const cyberAugmentCost = augments.cost - augments.bioware_cost;
  const augmentCost = round2(augments.bioware_cost
    + cyberAugmentCost * surchargeFor("cyberware", gearCostMultiplier));

  // --- Zoetic bookkeeping ---------------------------------------------------
  const isSynthetic = character.heritage.type === "Synthetic";
  const augmentZr = isSynthetic ? 0.0 : round2(augments.zoetic_rating);
  const gearZr = round2(gearZoeticRating(character, data));
  const zrTotal = round2(augmentZr + gearZr);
  const hasAmpPowers = amp.powers_taken.size > 0;
  const houseZr = houseRule("zr") === "houserule";
  // House rule: cyber ZR reduces ZP directly and always (may go negative); gear
  // ZR does NOT touch ZP (it penalises casting instead). Classic: total carried
  // ZR counts against ZP only when amp powers are taken.
  const zpRemaining = round2(heritage.zoetic_potential - amp.spent
    - (houseZr ? augmentZr : (hasAmpPowers ? zrTotal : 0)));
  // House rule: ZP ≤ 0 takes all magic offline except Rituals.
  const magicOffline = houseZr && magicType !== "Hedge" && zpRemaining <= 0;
  const ampOffline = houseZr ? magicOffline : (hasAmpPowers && zpRemaining < 0);
  if (magicOffline) {
    warnings.push("Magic OFFLINE: Zoetic Potential is 0 or less (cyber ZR + Amp "
      + "spending). Spells, Amps and Summoning are unavailable — only Rituals remain.");
  } else if (ampOffline) {
    warnings.push("Amp powers OFFLINE: ZP is negative — Amp ZP spent plus "
                  + "carried ZR exceeds Zoetic Potential.");
  }
  // House rule: each full point of gear/weapon ZR is a −1d penalty on casting
  // rolls (Channeling, Conjuring, Sorcery), surfaced as a note on those skills.
  if (houseZr && magicType !== "Hedge") {
    const castPenalty = Math.floor(gearZr);
    if (castPenalty > 0) {
      for (const sk of ["Channeling", "Conjuring", "Sorcery"]) {
        const s = skillScoring.skills[sk];
        if (s && (s.points > 0 || s.final > 0))
          s.notes = [...(s.notes || []), `−${castPenalty}d on casting rolls (gear/weapon ZR ${gearZr})`];
      }
    }
  }

  const cashCategories = {
    "Weapons/Armor": round2(weapons.cost + armor.cost),
    "Augments": augmentCost,
    "Drones/Vehicles/Rigs": round2(vehicles.cost + rig.cost),
    "Decks and Programs": round2(decking.cost),
    "Gear": round2(misc.gear_cost),
    "Lifestyle": round2(misc.lifestyle_cost),
  };
  const cashSpent = round2(Object.values(cashCategories).reduce((a, b) => a + b, 0));
  const cashRemaining = round2(priorities.starting_cash - cashSpent);
  if (cashRemaining < 0) {
    errors.push(`Cash overspent by ㄓ${Math.round(-cashRemaining).toLocaleString("en-US")}.`);
  }

  // Every character must live somewhere: at least one prepaid month of a lifestyle.
  const hasLifestyle = (character.lifestyles || []).some(ls => (Number(ls.months) || 0) >= 1)
    || (character.lifestyle && character.lifestyle.name && (Number(character.lifestyle.months) || 0) >= 1);
  if (!hasLifestyle) {
    errors.push("Choose a lifestyle with at least 1 prepaid month.");
  }

  const combat = deriveCombatStats(
    heritage, finalAttributes, augments, amp,
    weapons.weight, armor.weight, misc.gear_weight,
    augments.zoetic_rating_raw,
    armor.ballistic_armor, armor.impact_armor,
    armor.ballistic_armor_max);

  const martialArtsList = resolveMartialArts(character, data);
  const martialArt = aggregateMartialArts(martialArtsList);   // combined, for combat consumers
  const initiative = deriveInitiative(pools, finalAttributes, heritage, augments, amp,
                                      martialArt, data);
  const poolNotes = derivePoolNotes(heritage, augments, amp, martialArt);

  const combatOut = {};
  for (const [k, v] of Object.entries(combat)) {
    if (k !== "physical" && k !== "stun") combatOut[k] = v;
  }
  combatOut.exploit_actions = deriveExploitActions(character, data, magicType, augments, amp);

  // Apply the martial art's stat modifiers (gated by Martial Arts rank via the
  // cumulative levels resolved above) on top of heritage/augment bonuses.
  const maMods = martialArt.mods;
  combatOut.dodge_bonus += maMods.dodge_bonus;
  combatOut.soak_bonus += maMods.soak_bonus;
  combatOut.move += maMods.move_bonus;
  if (maMods.recoil_ignored) combatOut.recoil_ignored = 1;
  combatOut.martial_notes = maMods.applied;
  // Natural / implanted / power-granted melee weapons for the Overview loadout,
  // plus heritage bite/spit attacks (Shark, Snake).
  combatOut.granted_weapons = [
    ...collectGrantedWeapons(augments, amp, finalAttributes.Strength, maMods),
    ...heritageNaturalWeapons(heritage, character, finalAttributes.Strength),
  ];
  // Heavy Torso / No Head free-mount gear (weapons + extra limbs) for the loadout.
  combatOut.trait_gear = heritage.trait_gear || [];

  // Per-source breakdowns so the Combat box can show where each Soak/Dodge die
  // comes from — every contributing source in one place (the sweep).
  const hasPsa = amp.powers_taken.has("Perfect Situational Awareness");
  const fmtSrc = list => list.filter(([, d]) => d).map(([label, d]) => `${label} +${d}`);
  combatOut.soak_sources = fmtSrc([
    ["Heritage", heritage.soak_bonus],
    ["Perfect Situational Awareness", hasPsa ? PERFECT_SITUATIONAL_AWARENESS_BONUS : 0],
    [martialArt.style || "Martial art", maMods.soak_bonus],
  ]);
  combatOut.dodge_sources = fmtSrc([
    ["Heritage", heritage.dodge_bonus],
    ["Augments", augments.dodge_bonus],
    ["Perfect Situational Awareness", hasPsa ? PERFECT_SITUATIONAL_AWARENESS_BONUS : 0],
    [martialArt.style || "Martial art", maMods.dodge_bonus],
  ]);

  // Some sources zero out condition-track wound penalties (Pain Nullifier
  // augment, the Shibumi martial art, …). Detect data-driven: any effect text
  // that both mentions "wound penalt(y)" and a removal verb.
  const removesWoundPenalty = text =>
    /wound penalt/i.test(text) && /(remove|ignore|negat|nullif|zero|no\b)/i.test(text);
  combatOut.wound_penalty_negated =
    augments.rows.some(([row]) => removesWoundPenalty(row.Effect || row.Description || ""))
    || martialArt.levels.some(lvl => removesWoundPenalty(lvl.Effect || ""))
    || heritage.traits.some(row => removesWoundPenalty(row.Effects || ""));

  // Others double them — the Reaction Enhancer bioware ("+N Reaction but
  // doubles pain-based penalties") trades pain tolerance for reflexes. Scanned
  // the same data-driven way, so homebrew worded alike behaves alike. Negation
  // wins over doubling: twice nothing is still nothing.
  const doublesWoundPenalty = text =>
    /doubl/i.test(text) && /(wound|pain)[- ]?(based )?penalt/i.test(text);
  const doublingSource =
    augments.rows.find(([row]) =>
      doublesWoundPenalty(row.Effect || row.Description || ""))?.[0]?.Name
    || martialArt.levels.find(lvl => doublesWoundPenalty(lvl.Effect || ""))?.Style
    || heritage.traits.find(row => doublesWoundPenalty(row.Effects || ""))?.Name
    || "";
  combatOut.wound_penalty_doubled = !combatOut.wound_penalty_negated && !!doublingSource;
  combatOut.wound_penalty_doubled_by = combatOut.wound_penalty_doubled ? doublingSource : "";

  return {
    priorities: {
      values: priorities.values, remaining: priorities.remaining,
      magic_type: magicType, magic_priority_label: priorities.magic_priority_label,
      starting_attr_pts: priorities.starting_attr_pts,
      starting_skill_pts: priorities.starting_skill_pts,
      starting_cash: priorities.starting_cash,
      allowed_heritages: priorities.allowed_heritages,
    },
    attributes: attributeScoring.attributes,
    attr_points: attributeScoring.points,
    pools,
    skills: skillScoring.skills,
    ritual_skills: skillScoring.ritual_skills,
    skill_points: skillScoring.points,
    knowledge,
    etiquette_points: etiquettePoints,
    magic: {
      type: magicType,
      start_force: magicBudget.start_force,
      force_spent: magicBudget.force_spent,
      force_remaining: magicBudget.force_remaining,
      amp_zp_budget: heritage.zoetic_potential,
      amp_zp_spent: round2(amp.spent),
      amp_zp_remaining: round2(heritage.zoetic_potential - amp.spent),
      infusion_pts: magicBudget.infusion_pts,
      relationship_pts: magicBudget.relationship_pts,
    },
    zoetics: { zp: heritage.zoetic_potential,
               ghost_rating: (character.play && character.play.ghost_rating) || GHOST_RATING_DICE,
               zp_remaining: zpRemaining,
               amp_zp_spent: round2(amp.spent),
               augment_zr: augmentZr,
               gear_zr: gearZr,
               zr_total: zrTotal,
               amp_offline: ampOffline,
               magic_offline: magicOffline,
               cyber_zr: round2(augments.zoetic_rating),
               amp_zr: round2(amp.spent),
               // Gear-mounted augments: ZR exempt from ZP by design; the
               // errors are mirrored here because `errors` is blanked once
               // the character is finalized and play mode must still show them.
               mounted_zr: round2(augments.mounted_zr || 0),
               mount_errors: augments.mount_errors || [],
               body_index: round2(augments.body_index),
               body_index_ok: bodyIndexOk },
    condition: { physical: combat.physical, stun: combat.stun },
    combat: combatOut,
    initiative,
    pool_notes: poolNotes,
    weapons: weapons.items,
    armor: armor.items,
    drones: vehicles.drones,
    vehicles: vehicles.vehicles,
    martial_art: martialArt,        // aggregate (combined styles) — combat consumers
    martial_arts: martialArtsList,  // per-style list — UI display / editing
    budget: { starting_cash: priorities.starting_cash, categories: cashCategories,
              spent: cashSpent, remaining: cashRemaining,
              gear_cost_multiplier: gearCostMultiplier,
              armor_cost_multiplier: armorCostMultiplier },
    warnings: finalized ? [] : warnings,
    errors: finalized ? [] : errors,
  };
}

return {
  calculate,
  defaultCharacter,
  mergeDefaults,
  // exposed for the UI and tests
  asNumber, loadData,
  ATTRIBUTES, SKILLS, ETIQUETTES, POOL_NAMES,
  MAGIC_TYPE_BY_PRIORITY, MAGIC_TYPES_ALLOWED_BY_PRIORITY,
  SPELL_FORCE_MAX, SKILL_RANK_CAP, HACKING_RATING_COST, HACKING_RATING_MAX,
  GHOST_RATING_DICE,
  rigStats, applyExtendedMagazine, meleeDamage, assignWeaponModSlots,
  mountCapability, mountRefusal, augmentEffZr, augmentEffCost, augmentQualityMultiplier,
  augmentLimbRequirement, augmentMeleeDamage,
  HOUSE_RULE_DEFS, houseRule, setHouseRule, currencyName,
  programSkill, isEWProgram, hackActionSkill,
  VEHICLE_CONDITIONS, VEHICLE_CONDITION_FACTORS,
  surchargeFor,
};

})();

if (typeof module !== "undefined") module.exports = RULES;
