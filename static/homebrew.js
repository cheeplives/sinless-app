/**
 * homebrew.js — user-created custom content (homebrew) editor.
 *
 * Loaded between storage.js and app.js and shares the app's globals
 * (DATA/el/$/fmt at event time; DATA_BUNDLE/STORAGE at merge time).
 *
 * Custom rows are organised into named PACKS ({id,name,is_public,data}); data is
 * keyed by data.js table name in the exact column schema (string values, marker
 * Custom:"Y"). mergeCustomContent() splices my packs (editable) then subscribed
 * packs (read-only) into the live DATA_BUNDLE.tables arrays — the same arrays
 * every chargen picker, play-mode buy list, and rules.js lookup reads — so custom
 * content appears everywhere with no other integration. First writer of a name
 * wins: core > my packs > subscriptions.
 *
 * Packs sync per-user (STORAGE.loadPacks/loadSubs cache; SYNC mirrors to the
 * server). A pack can be published (is_public) so other members find it in the
 * Shared gallery and either Import a copy or Subscribe (live merge). JSON file
 * export/import stays as an offline fallback. In local-only mode packs live only
 * in localStorage (string ids) and there's no gallery/publish.
 */
"use strict";

/* Homebrew is organised into named packs. HB_PACKS are my editable packs
 * ({id,name,is_public,data}); HB_SUBS are packs I subscribe to, merged read-only.
 * A pack's `data` is {tableKey:[rows]}. Server ids are numbers; offline/local-only
 * packs use string ids and never sync. */
let HB_PACKS = null;
let HB_SUBS = null;
let hbActivePackId = null;    // which of my packs the editor is editing
let hbView = "editor";       // "editor" | "gallery"
let HB_GALLERY = null;       // cached public-pack listing for the gallery
let HB_SUB_IDS = null;       // Set of pack ids I'm subscribed to (for gallery buttons)

let hbTable = "weapons";     // active editor tab (table key)
let hbEditIndex = null;      // index into the active pack's rows being edited; null = adding
let hbReturnTo = "app";      // which screen Back returns to

function hbOnline() {
  return typeof SYNC !== "undefined" && SYNC.enabled && SYNC.enabled();
}

/* ---- per-table editor config ------------------------------------------ */
/* The 16 homebrew-eligible data.js tables and the columns the editor exposes.
 * Field flags: ta = textarea, select = fixed choices (app logic gates on the
 * value), datalist = suggestions but free-form allowed, hint = placeholder.
 *
 * Each nameKey must match NAME_KEYS in tools/promote_homebrew.py and the table
 * catalogue in docs/DATA.md -- tools/check_data.py enforces all three agree.
 * Fields listed here are the only ones an imported pack keeps (mergePackData
 * drops the rest), so adding a column to a table means adding it here too. */
const HOMEBREW_CONFIG = {
  rituals: { label: "Rituals", nameKey: "Name", fields: [
    { key: "Name" },
    { key: "Drain", hint: "number" },
    { key: "Time", hint: "e.g. 10 min" },
    { key: "Effect", ta: true },
    { key: "Description", ta: true },
  ]},
  speaker_spirits: { label: "Spirits", nameKey: "Spirit", fields: [
    { key: "Spirit" },
    { key: "Element", datalist: () => hbDistinct("speaker_elements", "Element") },
    { key: "Cost", hint: "relationship points" },
    { key: "Firearm", ta: true },
    { key: "Protection", ta: true },
    { key: "Drone", ta: true },
    { key: "Digital", ta: true },
    { key: "Physical", ta: true },
    { key: "Appearance", ta: true },
    // Services/Attacks/Special pack several entries into one cell, separated by
    // " | ". Write the spirit's Force as [F] and the sheet resolves it live.
    { key: "Bound Services", ta: true },
    { key: "Movement" },
    { key: "Initiative" },
    { key: "Condition" },
    { key: "Ballistic" },
    { key: "Impact" },
    { key: "Defense Dice" },
    { key: "Statblock Of", hint: "blank unless the stats are a summoned cohort's" },
    { key: "Attacks", ta: true },
    { key: "Special", ta: true },
  ]},
  spells: { label: "Spells", nameKey: "Name", fields: [
    { key: "Name" },
    { key: "School", datalist: () => hbDistinct("spells", "School") },
    { key: "Target Resistance" },
    { key: "Duration" },
    { key: "Drain", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Effect", ta: true },
    { key: "Description", ta: true },
  ]},
  misc_gear: { label: "Gear", nameKey: "Item", fields: [
    { key: "Item" },
    { key: "Class", datalist: () => hbDistinct("misc_gear", "Class"),
      hint: "new classes make new picker groups" },
    { key: "Cost", hint: "number" },
    { key: "Dependence", hint: "addiction factor" },
    { key: "Weight", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Mount Types", datalist: () => ["Any",
        ...hbDistinct("augments", "Type").filter(t => t !== "Bioware")],
      hint: "augment types this can mount — comma-separated, or Any; blank = none" },
    { key: "Mount ZP", hint: "ZP capacity for mounted augments (exempt from the character's ZP)" },
    { key: "Effect", ta: true },
    { key: "Notes", ta: true, hint: "restrictions or usage notes (e.g. which guns take this ammo)" },
  ]},
  augments: { label: "Augments", nameKey: "Name", fields: [
    { key: "Name", hint: "end with a number (“Reflex Booster 2”) for rank logic" },
    { key: "Type", select: () => hbDistinct("augments", "Type") },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Strength", hint: "+N" },
    { key: "Body", hint: "+N" },
    { key: "Reaction", hint: "+N" },
    { key: "Intelligence", hint: "+N" },
    { key: "Armor Slot", hint: "N or slot name" },
    { key: "Impact Armor" },
    { key: "ImpArmMin" },
    { key: "Ballistic Armor" },
    { key: "Ban", hint: "name prefixes this bans" },
    { key: "Effect", ta: true },
    { key: "Description", ta: true },
  ]},
  weapons: { label: "Weapons", nameKey: "Weapon", fields: [
    { key: "Weapon" },
    { key: "Type", select: () => Object.keys(WEAPON_TYPE_LABELS),
      optionLabel: k => `${WEAPON_TYPE_LABELS[k]} (${k})` },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Reach", hint: "Melee reach or “Ranged”" },
    { key: "Damage", hint: "e.g. 8; for Melee this is the base added to a share of Strength" },
    { key: "STR Mult", hint: "Melee only, share of Strength added — default 0.5, e.g. 1 for full STR" },
    { key: "StrCost", hint: "Bows only — cost per point of Minimum Strength. Setting it makes the weapon STR-rated: leave Cost, Damage and Rarity blank" },
    { key: "StrDmg", hint: "Bows only — added to Minimum Strength for damage" },
    { key: "Damage Bonus", hint: "Melee only, e.g. +2d6" },
    { key: "Firing modes", hint: "e.g. SS, BF, FA" },
    { key: "Ammo", hint: "magazine size" },
    { key: "Pen", hint: "armor penetration" },
    { key: "Bar", hint: "Barrier rating 0-5 — blank if it doesn't apply" },
    { key: "Conceal", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Hardening", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Upgr1_Cost", hint: "Upgrade 1 cost — Woolongs plus optional special part, e.g. “1500 + 50 Tc”" },
    { key: "Upgr1_Eff", hint: "Upgrade 1 effect, e.g. “Barrel Detailing (+1 damage)”" },
    { key: "Upgr2_Cost", hint: "Upgrade 2 cost — same format as Upgrade 1" },
    { key: "Upgr2_Eff", hint: "Upgrade 2 effect" },
    { key: "Mount Types", datalist: () => ["Any",
        ...hbDistinct("augments", "Type").filter(t => t !== "Bioware")],
      hint: "augment types this can mount — comma-separated, or Any; blank = none" },
    { key: "Mount ZP", hint: "ZP capacity for mounted augments (exempt from the character's ZP)" },
    { key: "Notes", ta: true },
  ]},
  armor: { label: "Armor", nameKey: "Armor", fields: [
    { key: "Armor" },
    { key: "Slot", select: () => ["Outer", "Under", "Other"] },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Ballistic", hint: "number" },
    { key: "Impact", hint: "number" },
    { key: "wt", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Style", select: () => ["", "Y"],
      optionLabel: v => v === "Y" ? "Y (styleable)" : "(fixed)" },
    { key: "Mount Types", datalist: () => ["Any",
        ...hbDistinct("augments", "Type").filter(t => t !== "Bioware")],
      hint: "augment types this can mount — comma-separated, or Any; blank = none" },
    { key: "Mount ZP", hint: "ZP capacity for mounted augments (exempt from the character's ZP)" },
  ]},
  vehicles: { label: "Vehicles", nameKey: "Vehicle", fields: [
    { key: "Vehicle" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Body", hint: "number" },
    { key: "Move" },
    { key: "Handling", hint: "number" },
    { key: "Cargo" },
    { key: "Rarity", hint: "number" },
    { key: "Armor" },
    { key: "Impact", hint: "number" },
    { key: "Ballistic", hint: "number" },
  ]},
  drones: { label: "Drones", nameKey: "Drone", fields: [
    { key: "Drone" },
    { key: "Frame", datalist: () => hbDistinct("drones", "Frame") },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Body", hint: "number" },
    { key: "WW" },
    { key: "Move" },
    { key: "Handling", hint: "number" },
    { key: "Hard Point", hint: "number of mounts" },
    { key: "Rarity", hint: "number" },
    { key: "Armor" },
    { key: "Impact", hint: "number" },
    { key: "Ballistic", hint: "number" },
    { key: "Effect", ta: true },
  ]},
  weapon_mods: { label: "Weapon Mods", nameKey: "Modification", fields: [
    { key: "Modification" },
    { key: "Slot", select: () => hbDistinct("weapon_mods", "Slot") },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Effect", ta: true },
    { key: "RecoilMod", hint: "+/-N" },
    { key: "AccMod", hint: "+/-N" },
    { key: "MagMod", hint: "e.g. x1.5" },
    { key: "HardMod", hint: "+/-N" },
    { key: "Conceal Mod", hint: "+/-N" },
  ]},
  vehicle_ballistic_weapons: { label: "Vehicle Ballistic", nameKey: "Vehicle Ballistic Weapon", fields: [
    { key: "Vehicle Ballistic Weapon" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Damage", hint: "number" },
    { key: "Ammo" },
    { key: "Modes", hint: "e.g. SS, BF, FA" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Pen", hint: "armor penetration" },
    { key: "Effect", ta: true },
    { key: "ModeEffect", ta: true },
  ]},
  vehicle_energy_weapons: { label: "Vehicle Energy", nameKey: "Vehicle Energy Weapon", fields: [
    { key: "Vehicle Energy Weapon" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Damage", hint: "number" },
    { key: "Heat", hint: "number" },
    { key: "Heat Limit", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Pen", hint: "armor penetration" },
    { key: "ModeEffect", ta: true },
  ]},
  drone_ballistic_weapons: { label: "Drone Ballistic", nameKey: "Drone Ballistic Weapon", fields: [
    { key: "Drone Ballistic Weapon" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Damage", hint: "number" },
    { key: "Ammo" },
    { key: "Modes", hint: "e.g. SS, BF, FA" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Pen", hint: "armor penetration" },
    { key: "Effect", ta: true },
    { key: "ModeEffect", ta: true },
  ]},
  drone_energy_weapons: { label: "Drone Energy", nameKey: "Drone Energy Weapon", fields: [
    { key: "Drone Energy Weapon" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Accuracy", hint: "number" },
    { key: "Damage", hint: "number" },
    { key: "Heat", hint: "number" },
    { key: "Heat Limit", hint: "number" },
    { key: "Rarity", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "Pen", hint: "armor penetration" },
    { key: "ModeEffect", ta: true },
  ]},
  vehicle_mods: { label: "Vehicle Mods", nameKey: "Vehicle Mod", fields: [
    { key: "Vehicle Mod" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "ModeEffect", ta: true },
  ]},
  drone_mods: { label: "Drone Mods", nameKey: "Drone Mod", fields: [
    { key: "Drone Mod" },
    { key: "ZR", hint: "number" },
    { key: "BI", hint: "number" },
    { key: "Cost", hint: "number" },
    { key: "Weight", hint: "number" },
    { key: "ModeEffect", ta: true },
  ]},
};

/* Columns a row genuinely needs to behave like the thing it claims to be.
 *
 * Every numeric column is read through `asNumber`, so a blank one is silently 0
 * — a weapon authored with nothing but a name is accepted, costs nothing, does
 * no damage, contributes no ZR, and raises nothing anywhere. Nothing here
 * BLOCKS a save (the free-form data model is deliberate, and a placeholder row
 * is a reasonable thing to want): leaving one blank asks for confirmation and
 * says what it will read as. Only the name is genuinely required.
 *
 * Listed per table rather than as a flag on each field so the shape of the
 * requirement is visible in one place. Keys must exist in HOMEBREW_CONFIG. */
const HOMEBREW_REQUIRED = {
  rituals: ["Drain"],
  speaker_spirits: ["Element", "Cost"],
  spells: ["School", "Drain", "Cost"],
  misc_gear: ["Class", "Cost"],
  augments: ["Type", "ZR", "BI", "Cost"],
  weapons: ["Type", "Cost", "Damage"],
  armor: ["Slot", "Cost", "Ballistic", "Impact"],
  vehicles: ["Cost", "Body", "Move", "Handling"],
  drones: ["Cost", "Body", "Move", "Handling", "WW", "Hard Point"],
  weapon_mods: ["Slot", "Cost"],
  vehicle_ballistic_weapons: ["Cost", "Damage", "Weight"],
  vehicle_energy_weapons: ["Cost", "Damage", "Weight"],
  drone_ballistic_weapons: ["Cost", "Damage", "Weight"],
  drone_energy_weapons: ["Cost", "Damage", "Weight"],
  vehicle_mods: ["Cost", "Weight"],
  drone_mods: ["Cost", "Weight"],
};

/** Required columns of `tableKey` that `row` leaves blank. */
function hbMissingColumns(tableKey, row) {
  return (HOMEBREW_REQUIRED[tableKey] || [])
    .filter(col => String(row[col] ?? "").trim() === "");
}

/* Sorted unique non-empty values of one column, read from the live merged
 * table so existing custom rows contribute their groups too. */
function hbDistinct(tableKey, col) {
  const seen = new Set();
  for (const row of DATA_BUNDLE.tables[tableKey] || [])
    if (row[col] != null && String(row[col]).trim() !== "") seen.add(String(row[col]));
  return [...seen].sort();
}

/* ---- pack state ---------------------------------------------------------- */
function hbLoad() {
  HB_PACKS = STORAGE.loadPacks();
  HB_SUBS = STORAGE.loadSubs();
  if (!HB_PACKS.some(p => p.id === hbActivePackId))
    hbActivePackId = HB_PACKS.length ? HB_PACKS[0].id : null;
}
function activePack() {
  if (!HB_PACKS) hbLoad();
  return HB_PACKS.find(p => p.id === hbActivePackId) || null;
}
function subscribedPacks() { if (!HB_SUBS) hbLoad(); return HB_SUBS; }

/* ---- merge into the live game data ------------------------------------ */
/* Strip prior custom rows, then merge my packs (editable) followed by
 * subscribed packs (read-only). First writer of a name wins, so core data keeps
 * its name, then my packs, then subscriptions; skipped collisions are recorded
 * on HB_COLLISIONS for the editor to surface. In-place splice/push keeps the
 * array references rules.js captured at load. */
let HB_COLLISIONS = [];
function mergeCustomContent() {
  if (!HB_PACKS) hbLoad();
  HB_COLLISIONS = [];
  const sources = [
    ...HB_PACKS.map(p => ({ pack: p, readOnly: false })),
    ...subscribedPacks().map(p => ({ pack: p, readOnly: true })),
  ];
  for (const key of Object.keys(HOMEBREW_CONFIG)) {
    const table = DATA_BUNDLE.tables[key];
    if (!table) continue;
    for (let i = table.length - 1; i >= 0; i--)
      if (table[i].Custom === "Y") table.splice(i, 1);
    const nameKey = HOMEBREW_CONFIG[key].nameKey;
    const taken = new Set(table.map(r => String(r[nameKey] || "").trim().toLowerCase()));
    for (const src of sources) {
      for (const row of (src.pack.data && src.pack.data[key]) || []) {
        const nm = String(row[nameKey] || "").trim().toLowerCase();
        if (!nm) continue;
        if (taken.has(nm)) {
          HB_COLLISIONS.push({ table: key, name: row[nameKey],
            pack: src.pack.name || "", owner: src.pack.owner || "" });
          continue;
        }
        taken.add(nm);
        const merged = { ...row, Custom: "Y", PackId: src.pack.id };
        if (src.readOnly) { merged.ReadOnly = "Y"; merged.Source = src.pack.owner || src.pack.name || ""; }
        table.push(merged);
      }
    }
  }
}

/* Persist the active pack (local cache + best-effort server), then re-merge. */
function hbSave() {
  STORAGE.cachePacks(HB_PACKS);
  const pack = activePack();
  if (pack && hbOnline() && typeof pack.id === "number") SYNC.savePack(pack.id, pack.data);
  mergeCustomContent();
}

/* ---- pack CRUD ----------------------------------------------------------- */
async function hbCreatePack(name) {
  name = String(name || "").trim() || "New Pack";
  const data = STORAGE.emptyPackData();
  let id = STORAGE.newLocalPackId();
  if (hbOnline()) { const res = await SYNC.createPack(name, data); if (res && res.id != null) id = res.id; }
  HB_PACKS.push({ id, name, is_public: false, data });
  hbActivePackId = id;
  STORAGE.cachePacks(HB_PACKS);
  mergeCustomContent();
}
function hbRenamePack(pack, name) {
  pack.name = String(name || "").trim() || pack.name;
  STORAGE.cachePacks(HB_PACKS);
  if (hbOnline() && typeof pack.id === "number") SYNC.savePack(pack.id, pack.data, pack.name);
}
function hbDeletePack(pack) {
  const i = HB_PACKS.indexOf(pack);
  if (i < 0) return;
  HB_PACKS.splice(i, 1);
  if (hbActivePackId === pack.id) hbActivePackId = HB_PACKS.length ? HB_PACKS[0].id : null;
  STORAGE.cachePacks(HB_PACKS);
  if (hbOnline() && typeof pack.id === "number") SYNC.deletePack(pack.id);
  mergeCustomContent();
}
async function hbTogglePublic(pack) {
  if (!hbOnline() || typeof pack.id !== "number") {
    alert("Sign in to publish a pack so other members can find it.");
    return;
  }
  const res = await SYNC.setPackVisibility(pack.id, !pack.is_public);
  if (res) { pack.is_public = res.is_public; STORAGE.cachePacks(HB_PACKS); }
  else alert("Couldn't change sharing — the pack may not be saved to the server yet.");
}

/* ---- screen management ------------------------------------------------- */
function enterHomebrew() {
  hbReturnTo = $("#sheet").hidden ? "app" : "sheet";
  hbEditIndex = null; hbView = "editor";
  hbLoad();
  $("#app").hidden = true;
  $("#sheet").hidden = true;
  $("#homebrew").hidden = false;
  renderHomebrew();
  window.scrollTo(0, 0);
  // Pull the latest packs/subscriptions in the background, then repaint.
  if (hbOnline()) hbRefreshFromServer().then(() => { if (!$("#homebrew").hidden) renderHomebrew(); });
}

/* Refresh my packs + subscriptions from the server into the local cache. When
 * signed in the server is the source of truth for packs (offline-only local
 * packs use string ids and simply aren't returned). */
async function hbRefreshFromServer() {
  const mine = await SYNC.listMyPacks();
  if (mine) STORAGE.cachePacks(mine);
  const subs = await SYNC.listSubs();
  if (subs) STORAGE.cacheSubs(subs);
  hbLoad();
  mergeCustomContent();
}

async function exitHomebrew() {
  $("#homebrew").hidden = true;
  await recalc();
  if (hbReturnTo === "sheet") {
    $("#sheet").hidden = false;
    renderSheet();
  } else {
    $("#app").hidden = false;
    renderPanel();
  }
}

/* ---- rendering ---------------------------------------------------------- */
/* Compact one-line summary of a row's non-empty fields (skipping the name
 * and the Custom marker) for list rows and the built-in reference. */
function hbRowSummary(cfg, row) {
  const parts = [];
  for (const f of cfg.fields) {
    if (f.key === cfg.nameKey) continue;
    const v = String(row[f.key] ?? "").trim();
    if (v !== "") parts.push(`${f.key} ${v}`);
  }
  return parts.join(" · ");
}

function packItemCount(pack) {
  if (!pack || !pack.data) return 0;
  return Object.keys(HOMEBREW_CONFIG).reduce((n, k) => n + ((pack.data[k] || []).length), 0);
}

function renderHomebrew() {
  const root = $("#homebrew");
  root.innerHTML = "";
  if (hbView === "gallery") { renderHomebrewGallery(root); return; }
  renderHomebrewEditor(root);
}

function renderHomebrewEditor(root) {
  const cfg = HOMEBREW_CONFIG[hbTable];
  const pack = activePack();
  const rows = pack ? pack.data[hbTable] : [];

  const importInput = el("input", {
    type: "file", accept: ".json,application/json", hidden: "1",
    onchange: async e => {
      const file = e.target.files[0]; e.target.value = "";
      if (!file) return;
      let parsed; try { parsed = JSON.parse(await file.text()); } catch { parsed = null; }
      importHomebrewFile(parsed);
    },
  });

  root.append(el("div", { class: "hb-head" },
    el("div", {},
      el("h2", {}, "Homebrew Content"),
      el("p", { class: "hint" },
        "Custom items merge into every picker and price calculation. Organise them "
        + "into packs, publish a pack to share it with other members, or subscribe "
        + "to someone else's — subscribed items appear everywhere, read-only.")),
    el("div", { class: "hb-head-actions" },
      el("button", { class: "btn ghost", onclick: exitHomebrew }, "← Back"),
      el("button", { class: "btn", onclick: openHomebrewGallery }, "Browse Shared"),
      pack ? el("button", { class: "btn", onclick: () => exportActivePack() }, "Export File") : null,
      el("button", { class: "btn", onclick: () => importInput.click() }, "Import File"),
      importInput)));

  /* ---- pack bar: choose / create / rename / delete / publish ------------- */
  const packBar = el("div", { class: "card hb-packbar" });
  if (!HB_PACKS.length) {
    packBar.append(el("p", { class: "hint" }, "You have no homebrew packs yet."),
      el("button", { class: "btn-add", onclick: async () => {
        const name = (prompt("Name this pack:", "My Homebrew") || "").trim();
        if (name === "") return;
        await hbCreatePack(name); renderHomebrew();
      } }, "+ Create a pack"));
  } else {
    const sel = el("select", { onchange: e => { hbActivePackId = castPackId(e.target.value); hbEditIndex = null; renderHomebrew(); } },
      ...HB_PACKS.map(p => el("option", { value: String(p.id), ...(p.id === hbActivePackId ? { selected: 1 } : {}) },
        `${p.name} (${packItemCount(p)})${p.is_public ? " · public" : ""}`)));
    packBar.append(el("div", { class: "hb-packrow" },
      el("span", { class: "hb-field-name" }, "Pack"), sel,
      pack && pack.is_public ? el("span", { class: "sh-tag magic" }, "public") : null,
      el("button", { class: "btn small", onclick: async () => {
        const name = (prompt("New pack name:", "New Pack") || "").trim();
        if (name === "") return;
        await hbCreatePack(name); renderHomebrew();
      } }, "+ New"),
      el("button", { class: "btn small", onclick: () => {
        const name = (prompt("Rename pack:", pack.name) || "").trim();
        if (name === "" || name === pack.name) return;
        hbRenamePack(pack, name); renderHomebrew();
      } }, "Rename"),
      el("button", { class: "btn small",
        title: hbOnline() ? "" : "Sign in to publish a pack",
        onclick: async () => { await hbTogglePublic(pack); renderHomebrew(); } },
        pack.is_public ? "Make private" : "Publish"),
      el("button", { class: "row-del", title: "Delete pack",
        onclick: () => {
          if (!confirm(`Delete the whole pack “${pack.name}” and its ${packItemCount(pack)} item(s)?`)) return;
          hbDeletePack(pack); renderHomebrew();
        } }, "✕ Delete pack")));
  }
  root.append(packBar);

  if (!pack) return;   // nothing more to show until a pack exists

  /* ---- table tabs (counts are for the active pack) ---------------------- */
  root.append(el("div", { class: "hb-tabs" },
    ...Object.entries(HOMEBREW_CONFIG).map(([key, c]) =>
      el("button", {
        class: "hb-tab" + (key === hbTable ? " active" : ""),
        onclick: () => { hbTable = key; hbEditIndex = null; renderHomebrew(); },
      }, `${c.label}${(pack.data[key] || []).length ? ` (${pack.data[key].length})` : ""}`))));

  /* ---- this pack's rows for the active table --------------------------- */
  const list = el("div", { class: "card" }, el("h3", {}, `${pack.name} — ${cfg.label}`));
  if (!rows.length) {
    list.append(el("p", { class: "hint" }, `No ${cfg.label.toLowerCase()} in this pack yet — add one below.`));
  } else {
    const t = el("table");
    rows.forEach((row, i) => {
      const missing = hbMissingColumns(hbTable, row);
      t.append(el("tr", {},
        el("td", {}, el("b", {}, row[cfg.nameKey] || "(unnamed)"),
          el("div", { class: "sub" }, hbRowSummary(cfg, row)),
          missing.length
            ? el("div", { class: "sub", style: "color:var(--amber)" },
                `⚠ blank: ${missing.join(", ")} — reads as 0 / none`)
            : null),
        el("td", { class: "hb-row-actions" },
          el("button", { class: "btn small", onclick: () => { hbEditIndex = i; renderHomebrew(); } }, "Edit"),
          el("button", { class: "row-del", title: "Delete",
            onclick: () => {
              const name = row[cfg.nameKey] || "(unnamed)";
              if (!confirm(`Delete ${name}? Characters that own it keep the name but lose its stats.`)) return;
              rows.splice(i, 1);
              if (hbEditIndex === i) hbEditIndex = null;
              hbSave(); renderHomebrew();
            } }, "✕"))));
    });
    list.append(t);
  }
  root.append(list);

  /* ---- add / edit form (writes into the active pack) ------------------- */
  const editing = hbEditIndex != null ? rows[hbEditIndex] : null;
  const form = el("div", { class: "card" },
    el("h3", {}, editing ? `Edit: ${editing[cfg.nameKey] || "(unnamed)"}` : `Add ${cfg.label.replace(/s$/, "")}`));
  const inputs = {};
  const grid = el("div", { class: "hb-form-grid" });
  for (const f of cfg.fields) {
    const current = editing ? String(editing[f.key] ?? "") : "";
    let control;
    if (f.select) {
      const opts = f.select();
      control = el("select", {},
        ...opts.map(v => el("option", { value: v }, f.optionLabel ? f.optionLabel(v) : (v || "(none)"))));
      control.value = opts.includes(current) ? current : opts[0];
    } else if (f.ta) {
      control = el("textarea", { rows: "2" }); control.value = current;
    } else {
      const attrs = { type: "text", ...(f.hint ? { placeholder: f.hint } : {}) };
      if (f.datalist) {
        const listId = `hb-dl-${hbTable}-${f.key.replace(/\W+/g, "-")}`;
        attrs.list = listId;
        grid.append(el("datalist", { id: listId }, ...f.datalist().map(v => el("option", { value: v }))));
      }
      control = el("input", attrs); control.value = current;
    }
    inputs[f.key] = control;
    grid.append(el("label", { class: "hb-field" + (f.ta ? " hb-wide" : "") },
      el("span", { class: "hb-field-name" }, f.key), control));
  }
  form.append(grid,
    el("div", { class: "hb-form-actions" },
      el("button", { class: "btn-add", onclick: () => {
        const row = {};
        for (const f of cfg.fields) row[f.key] = String(inputs[f.key].value ?? "").trim();
        row.Custom = "Y";
        const name = row[cfg.nameKey];
        if (!name) { alert(`${cfg.nameKey} is required.`); return; }
        // Collide against core + other packs + other rows in THIS pack.
        const taken = new Set(DATA_BUNDLE.tables[hbTable]
          .filter(r => !(r.Custom === "Y" && r.PackId === pack.id))
          .map(r => String(r[cfg.nameKey] || "").trim().toLowerCase()));
        rows.forEach((r, i) => { if (i !== hbEditIndex) taken.add(String(r[cfg.nameKey] || "").trim().toLowerCase()); });
        if (taken.has(name.toLowerCase())) {
          alert(`A ${cfg.label.replace(/s$/, "").toLowerCase()} named “${name}” already exists in the core data or another pack.`);
          return;
        }
        // Blank required columns read as 0 / none everywhere downstream, which
        // looks like the item not working rather than the row being incomplete.
        const missing = hbMissingColumns(hbTable, row);
        if (missing.length && !confirm(
          `“${name}” leaves these columns blank:\n\n  ${missing.join(", ")}\n\n`
          + "Blank numbers read as 0 and blank categories as none, so it will "
          + "cost nothing and do nothing in those respects.\n\nAdd it anyway?"))
          return;
        if (editing) rows[hbEditIndex] = row; else rows.push(row);
        hbEditIndex = null;
        hbSave(); renderHomebrew();
      } }, editing ? "Save Changes" : "Add"),
      editing ? el("button", { class: "btn ghost", onclick: () => { hbEditIndex = null; renderHomebrew(); } }, "Cancel") : null));
  root.append(form);

  /* ---- rows that never made it in -------------------------------------- */
  /* First writer of a name wins, so a homebrew row whose name matches core
   * data or an earlier pack is dropped at merge time. Without this card the
   * only symptom is content that simply never appears in any picker — the most
   * confusing possible failure, since the row is still sitting in the editor
   * looking fine. Covers every pack, not just the active one. */
  if (HB_COLLISIONS.length) {
    const card = el("div", { class: "card" },
      el("h3", {}, `Not merged — name already taken (${HB_COLLISIONS.length})`),
      el("p", { class: "hint" },
        "Core data wins over your packs, and your packs win over subscriptions. "
        + "These rows keep their place in their pack but never appear in a picker. "
        + "Rename them to bring them back."));
    const t = el("table");
    HB_COLLISIONS.forEach(c => t.append(el("tr", {},
      el("td", {}, el("b", {}, c.name),
        el("div", { class: "sub" }, (HOMEBREW_CONFIG[c.table] || {}).label || c.table)),
      el("td", { class: "sub" },
        `in ${c.pack || "(unnamed pack)"}${c.owner ? ` by ${c.owner}` : ""}`))));
    card.append(t);
    root.append(card);
  }

  /* ---- subscribed packs (read-only) ------------------------------------ */
  const subs = subscribedPacks();
  if (subs.length) {
    const card = el("div", { class: "card" }, el("h3", {}, "Subscribed packs (read-only)"));
    subs.forEach(sp => card.append(el("div", { class: "hb-packrow" },
      el("b", {}, sp.name),
      el("span", { class: "sub" }, `by ${sp.owner || "?"} · ${packItemCount(sp)} item(s)`),
      el("button", { class: "btn small", onclick: async () => {
        if (!confirm(`Unsubscribe from “${sp.name}”? Its items stop appearing in your pickers.`)) return;
        await SYNC.unsubscribePack(sp.id);
        await hbRefreshFromServer();
        renderHomebrew();
      } }, "Unsubscribe"))));
    root.append(card);
  }

  /* ---- built-in reference ---------------------------------------------- */
  const builtins = DATA_BUNDLE.tables[hbTable].filter(r => r.Custom !== "Y");
  const refTable = el("table");
  for (const row of builtins)
    refTable.append(el("tr", {}, el("td", {}, el("b", {}, row[cfg.nameKey] || ""),
      el("div", { class: "sub" }, hbRowSummary(cfg, row)))));
  root.append(el("details", { class: "card hb-ref" },
    el("summary", {}, `Built-in ${cfg.label} reference (${builtins.length})`), refTable));
}

/* Pack ids are numbers (server) or strings (local). <select> gives strings, so
 * coerce back to a number when the id is numeric. */
function castPackId(v) {
  return HB_PACKS.some(p => p.id === Number(v)) ? Number(v) : v;
}

/* ---- shared-homebrew gallery ------------------------------------------- */
async function openHomebrewGallery() {
  if (!hbOnline()) { alert("Sign in to browse packs shared by other members."); return; }
  hbView = "gallery"; HB_GALLERY = null;
  renderHomebrew();
  HB_GALLERY = await SYNC.listPublicPacks();
  HB_SUB_IDS = new Set(subscribedPacks().map(s => s.id));
  renderHomebrew();
}

function renderHomebrewGallery(root) {
  root.append(el("div", { class: "hb-head" },
    el("div", {}, el("h2", {}, "Shared Homebrew"),
      el("p", { class: "hint" }, "Packs published by other members. Subscribe to merge a pack live "
        + "(read-only, always current), or import a copy into one of your own packs.")),
    el("div", { class: "hb-head-actions" },
      el("button", { class: "btn ghost", onclick: () => { hbView = "editor"; renderHomebrew(); } }, "← Back to my packs"))));

  if (HB_GALLERY === null) { root.append(el("p", { class: "hint" }, "Loading…")); return; }
  const myIds = new Set(HB_PACKS.map(p => p.id));
  const packs = HB_GALLERY;
  if (!packs.length) { root.append(el("div", { class: "card" }, el("p", { class: "hint" }, "No shared packs yet."))); return; }

  const card = el("div", { class: "card" });
  const t = el("table");
  packs.forEach(p => {
    const mine = myIds.has(p.id);
    const subd = HB_SUB_IDS && HB_SUB_IDS.has(p.id);
    t.append(el("tr", {},
      el("td", {}, el("b", {}, p.name), mine ? el("span", { class: "sh-tag" }, "yours") : null,
        el("div", { class: "sub" }, `by ${p.owner} · ${p.item_count} item(s)`)),
      el("td", { class: "hb-row-actions" },
        el("button", { class: "btn small", onclick: () => viewSharedPack(p.id) }, "View"),
        mine ? null : el("button", { class: "btn small", onclick: () => importSharedPack(p) }, "Import copy"),
        mine ? null : el("button", { class: "btn small" + (subd ? " ghost" : ""),
          onclick: async () => {
            if (subd) await SYNC.unsubscribePack(p.id); else await SYNC.subscribePack(p.id);
            await hbRefreshFromServer();
            HB_SUB_IDS = new Set(subscribedPacks().map(s => s.id));
            renderHomebrew();
          } }, subd ? "Unsubscribe" : "Subscribe"))));
    if (p._preview) {
      const pre = el("td", { colspan: "2" }, el("div", { class: "sub" }, p._preview));
      t.append(el("tr", {}, pre));
    }
  });
  card.append(t);
  root.append(card);
}

async function viewSharedPack(id) {
  const full = await SYNC.fetchPublicPack(id);
  const p = HB_GALLERY.find(x => x.id === id);
  if (!p) return;
  if (!full) { p._preview = "Pack is no longer available."; renderHomebrew(); return; }
  const names = [];
  for (const [key, cfg] of Object.entries(HOMEBREW_CONFIG))
    for (const row of full.data[key] || []) names.push(row[cfg.nameKey]);
  p._preview = names.length ? "Contains: " + names.join(", ") : "(empty pack)";
  renderHomebrew();
}

/* Import a copy of a shared pack's items into one of my packs (a snapshot;
 * later author edits won't propagate). Merges into the active pack, or creates
 * a new one named after the source. Skips name collisions. */
async function importSharedPack(meta) {
  const full = await SYNC.fetchPublicPack(meta.id);
  if (!full) { alert("That pack is no longer available."); return; }
  let target = activePack();
  if (!target) { await hbCreatePack(full.name + " (imported)"); target = activePack(); }
  const { imported, skipped } = mergePackData(target, full.data);
  hbSave();
  renderHomebrew();
  alert(`Imported ${imported} item(s) into “${target.name}”.`
    + (skipped.length ? ` Skipped ${skipped.length} duplicate name(s).` : ""));
}

/* Merge rows from `src` data into `target` pack, coercing to the configured
 * columns and skipping names already present anywhere (core/packs/subs). */
function mergePackData(target, src) {
  let imported = 0; const skipped = [];
  for (const [key, cfg] of Object.entries(HOMEBREW_CONFIG)) {
    if (!Array.isArray(src[key])) continue;
    const taken = new Set(DATA_BUNDLE.tables[key].map(r => String(r[cfg.nameKey] || "").trim().toLowerCase()));
    for (const raw of src[key]) {
      if (!raw || typeof raw !== "object") continue;
      const row = {}; for (const f of cfg.fields) row[f.key] = String(raw[f.key] ?? "").trim();
      row.Custom = "Y";
      const name = row[cfg.nameKey];
      if (!name) continue;
      if (taken.has(name.toLowerCase())) { skipped.push(name); continue; }
      taken.add(name.toLowerCase());
      target.data[key].push(row);
      imported++;
    }
  }
  return { imported, skipped };
}

/* ---- file export / import (offline fallback, per active pack) ----------- */
function exportActivePack() {
  const pack = activePack();
  if (!pack) return;
  const out = { format: "sinless-homebrew", version: 2, name: pack.name, ...pack.data };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `sinless-homebrew-${STORAGE.sanitizeName(pack.name)}.json` });
  a.click();
  URL.revokeObjectURL(url);
}

/* Import a JSON pack file into the active pack (creating one if needed). */
async function importHomebrewFile(parsed) {
  const known = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.keys(HOMEBREW_CONFIG).some(k => Array.isArray(parsed[k]));
  if (!known) { alert("That file doesn't look like a Sinless homebrew pack."); return; }
  let target = activePack();
  if (!target) { await hbCreatePack(String(parsed.name || "Imported")); target = activePack(); }
  const { imported, skipped } = mergePackData(target, parsed);
  hbSave();
  renderHomebrew();
  alert(`Imported ${imported} item(s) into “${target.name}”.`
    + (skipped.length ? ` Skipped ${skipped.length} duplicate name(s): ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? ", …" : ""}.` : ""));
}
