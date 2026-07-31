/**
 * storage.js — localStorage character persistence (the synchronous working
 * store). Its public API is unchanged, so the rest of the app is untouched.
 *
 * Keys are namespaced by SYNC.userPrefix(): "sinless:" in local-only mode
 * (identical to the pre-server app) or "sinless:u<id>:" when signed in, so two
 * accounts on one browser stay separate and sign-out can wipe one cleanly.
 * When signed in, writes/deletes also notify SYNC to mirror them to the server;
 * `cacheCharacter`/`cacheCustomContent` are the no-notify variants SYNC uses
 * when hydrating FROM the server.
 */
"use strict";

const STORAGE = (() => {

const MAX_CHARACTER_NAME_LENGTH = 80;

/* Namespace prefix — consults SYNC at call time (SYNC may sign in/out during a
 * session). Falls back to the legacy "sinless:" when SYNC isn't present. */
function nsPrefix() {
  return (typeof SYNC !== "undefined" && SYNC.userPrefix) ? SYNC.userPrefix() : "sinless:";
}
function charPrefix() { return nsPrefix() + "char:"; }
function customKey()  { return nsPrefix() + "custom:content"; }

/** Turn a character name into a stable storage key: letters/digits/_/-
 * survive, everything else collapses to a hyphen; length-capped; never empty. */
function sanitizeName(name) {
  let cleaned = String(name || "unnamed").trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  cleaned = cleaned.slice(0, MAX_CHARACTER_NAME_LENGTH) || "unnamed";
  return cleaned;
}

function listCharacters() {
  const prefix = charPrefix();
  const names = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) names.push(key.slice(prefix.length));
  }
  return names.sort();
}

function loadCharacter(name) {
  const key = charPrefix() + sanitizeName(name);
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt entry (partial write, manual edit): drop it so it stops
    // breaking loads, and report nothing found.
    localStorage.removeItem(key);
    return null;
  }
}

/* Local write only (no server notify) — used by SYNC.hydrate. */
function cacheCharacter(character) {
  const saved = sanitizeName(character.name);
  localStorage.setItem(charPrefix() + saved, JSON.stringify(character));
  return saved;
}

function saveCharacter(character) {
  const saved = cacheCharacter(character);
  if (typeof SYNC !== "undefined" && SYNC.onSave) SYNC.onSave(character);
  return saved;
}

function deleteCharacter(name) {
  localStorage.removeItem(charPrefix() + sanitizeName(name));
  if (typeof SYNC !== "undefined" && SYNC.onDelete) SYNC.onDelete(name);
}

/* ---- homebrew custom content --------------------------------------------
 * One entry holds every user-created row, keyed by data.js table name, in the
 * exact column schema of that table (string values, marker Custom:"Y").
 * homebrew.js merges these into DATA_BUNDLE.tables at boot and after edits. */
const CUSTOM_TABLES = [
  "rituals", "spells", "speaker_spirits", "misc_gear", "augments", "weapons", "armor",
  "vehicles", "drones", "weapon_mods",
  "vehicle_ballistic_weapons", "vehicle_energy_weapons",
  "drone_ballistic_weapons", "drone_energy_weapons",
  "drone_mods", "vehicle_mods",
];

function loadCustomContent() {
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(customKey()) || "null"); }
  catch { /* corrupt entry: start fresh rather than break boot */ }
  const content = {};
  for (const t of CUSTOM_TABLES)
    content[t] = (parsed && Array.isArray(parsed[t])) ? parsed[t] : [];
  return content;
}

/* Local write only (no server push) — used by SYNC.hydrate. */
function cacheCustomContent(content) {
  localStorage.setItem(customKey(), JSON.stringify(content));
}

function saveCustomContent(content) {
  cacheCustomContent(content);
  if (typeof SYNC !== "undefined" && SYNC.pushCustomContent) SYNC.pushCustomContent(content);
}

/* ---- homebrew packs (named, shareable) ----------------------------------
 * Supersede the single custom:content blob. A pack is {id,name,is_public,data}
 * with data = {tableKey:[rows]}. `subs` caches subscribed (read-only) packs.
 * These are local caches; SYNC mirrors packs/subs to the server per user. */
function packsKey() { return nsPrefix() + "homebrew:packs"; }
function subsKey()  { return nsPrefix() + "homebrew:subs"; }

let localPackSeq = 0;
function newLocalPackId() {
  return "local-" + Date.now().toString(36) + "-" + (++localPackSeq);
}
function emptyPackData() {
  const d = {};
  for (const t of CUSTOM_TABLES) d[t] = [];
  return d;
}
function normalizePackData(data) {
  const d = {};
  for (const t of CUSTOM_TABLES) d[t] = (data && Array.isArray(data[t])) ? data[t] : [];
  return d;
}

/* My packs. First load with none present migrates a legacy custom:content blob
 * into a starter "My Homebrew" pack so nothing is lost. */
function loadPacks() {
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(packsKey()) || "null"); } catch { /* corrupt */ }
  if (Array.isArray(parsed))
    return parsed.map(p => ({ id: p.id, name: p.name || "Homebrew",
      is_public: !!p.is_public, data: normalizePackData(p.data) }));
  const legacy = loadCustomContent();
  if (CUSTOM_TABLES.some(t => (legacy[t] || []).length)) {
    const pack = { id: newLocalPackId(), name: "My Homebrew", is_public: false, data: legacy };
    cachePacks([pack]);
    return [pack];
  }
  return [];
}
function cachePacks(packs) {
  try { localStorage.setItem(packsKey(), JSON.stringify(packs)); } catch { /* quota */ }
}
function loadSubs() {
  try {
    const v = JSON.parse(localStorage.getItem(subsKey()) || "null");
    return Array.isArray(v) ? v.map(p => ({ id: p.id, name: p.name, owner: p.owner,
      data: normalizePackData(p.data) })) : [];
  } catch { return []; }
}
function cacheSubs(subs) { try { localStorage.setItem(subsKey(), JSON.stringify(subs)); } catch { /* quota */ } }

return { sanitizeName, listCharacters, loadCharacter, saveCharacter, deleteCharacter,
         cacheCharacter, loadCustomContent, saveCustomContent, cacheCustomContent,
         CUSTOM_TABLES, loadPacks, cachePacks, loadSubs, cacheSubs,
         newLocalPackId, emptyPackData, normalizePackData };

})();

if (typeof module !== "undefined") module.exports = STORAGE;
