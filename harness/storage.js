"use strict";

// An in-memory Web Storage (sessionStorage / localStorage). Hand the same
// storage to a form sandbox and an HTML page and they share it, as two frames
// on the same origin in one tab do.

function blockedError() {
  const error = new Error("FormScriptKit: storage is blocked");
  error.name = "SecurityError";
  return error;
}

function createStorage() {
  const entries = new Map();
  let blocked = false;

  function guard() {
    if (blocked) throw blockedError();
  }

  return {
    getItem(key) {
      guard();
      const name = String(key);
      return entries.has(name) ? entries.get(name) : null;
    },
    setItem(key, value) {
      guard();
      entries.set(String(key), String(value));
    },
    removeItem(key) {
      guard();
      entries.delete(String(key));
    },
    clear() {
      guard();
      entries.clear();
    },
    key(index) {
      guard();
      const name = Array.from(entries.keys())[Number(index)];
      return name === undefined ? null : name;
    },
    get length() {
      guard();
      return entries.size;
    },

    // Test-only members.

    /** When true, every Storage method and `length` throw a SecurityError. */
    get blocked() {
      return blocked;
    },
    set blocked(value) {
      blocked = Boolean(value);
    },
    /** A plain object of every entry, readable even while blocked. */
    snapshot() {
      return Object.fromEntries(entries);
    },
  };
}

module.exports = { createStorage };
