/**
 * storage.js — localStorage character persistence.
 *
 * Each character is stored under `sinless:char:<sanitized-name>`, so a given
 * street name always maps to the same slot. Characters are a few KB each;
 * localStorage's ~5 MB budget is ample.
 */
"use strict";

const STORAGE = (() => {

const KEY_PREFIX = "sinless:char:";
const MAX_CHARACTER_NAME_LENGTH = 80;

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
  const names = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(KEY_PREFIX)) names.push(key.slice(KEY_PREFIX.length));
  }
  return names.sort();
}

function loadCharacter(name) {
  const key = KEY_PREFIX + sanitizeName(name);
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

function saveCharacter(character) {
  const saved = sanitizeName(character.name);
  localStorage.setItem(KEY_PREFIX + saved, JSON.stringify(character));
  return saved;
}

function deleteCharacter(name) {
  localStorage.removeItem(KEY_PREFIX + sanitizeName(name));
}

return { sanitizeName, listCharacters, loadCharacter, saveCharacter, deleteCharacter };

})();

if (typeof module !== "undefined") module.exports = STORAGE;
