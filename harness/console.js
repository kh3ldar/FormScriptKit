"use strict";

const { toHost } = require("./realm");

// A console that records instead of printing. Arguments are copied into the
// test's realm at the moment of the call; Error arguments become { name, message }.

const LEVELS = ["log", "info", "warn", "error", "debug"];

function isError(value) {
  return Object.prototype.toString.call(value) === "[object Error]";
}

function createConsole() {
  const entries = [];
  const capture = { entries };
  for (const level of LEVELS) {
    capture[level] = (...args) => {
      const recorded = args.map((arg) =>
        isError(arg) ? { name: String(arg.name), message: String(arg.message) } : toHost(arg),
      );
      entries.push({ level, args: recorded });
    };
  }
  return capture;
}

module.exports = { createConsole, CONSOLE_LEVELS: LEVELS };
