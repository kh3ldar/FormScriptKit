"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createTimers } = require("./timers");
const { createStorage } = require("./storage");
const { createConsole, CONSOLE_LEVELS } = require("./console");

// One sandbox stands for one form's script frame: a vm context whose global
// is `window`, into which web resources are loaded unchanged, in order, the
// way a form loads its libraries. Libraries on one form share globals.
// The context is there for fidelity, not security: node:vm is not a security
// boundary, and the injected fakes, timers and URL classes are host objects.

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const DOTTED_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

function checkConsole(candidate) {
  const missing = CONSOLE_LEVELS.filter((level) => !candidate || typeof candidate[level] !== "function");
  if (missing.length > 0) {
    throw new TypeError(
      `FormScriptKit: the console option is "capture" or an object with ${CONSOLE_LEVELS.join("/")}; missing ${missing.join(", ")}`,
    );
  }
}

/**
 * Creates an empty sandbox. Options: globals, root, timers, console
 * ("capture" or a console-like object), sessionStorage, localStorage.
 */
function createSandbox(options = {}) {
  const known = new Set(["globals", "root", "timers", "console", "sessionStorage", "localStorage"]);
  for (const key of Object.keys(options)) {
    if (!known.has(key)) throw new TypeError(`FormScriptKit: createSandbox has no option "${key}"`);
  }
  const {
    globals = {},
    root = process.cwd(),
    timers = createTimers(),
    console: consoleOption = "capture",
    sessionStorage = createStorage(),
    localStorage = createStorage(),
  } = options;

  const capture = consoleOption === "capture" ? createConsole() : null;
  const sandboxConsole = capture || consoleOption;
  checkConsole(sandboxConsole);

  const context = vm.createContext({});
  const global = vm.runInContext("globalThis", context);
  vm.runInContext("globalThis.window = globalThis.self = globalThis.top = globalThis.parent = globalThis;", context);
  const realm = vm.runInContext("({ Object, Array, Date, Promise, Error, TypeError, SyntaxError })", context);

  Object.assign(context, {
    console: sandboxConsole,
    setTimeout: (callback, ms, ...args) => timers.setTimeout(callback, ms, ...args),
    clearTimeout: (handle) => timers.clearTimeout(handle),
    setInterval: (callback, ms, ...args) => timers.setInterval(callback, ms, ...args),
    clearInterval: (handle) => timers.clearInterval(handle),
    sessionStorage,
    localStorage,
    URL,
    URLSearchParams,
  });

  const files = [];
  const loadedNames = () => (files.length > 0 ? files.map((file) => path.basename(file)).join(", ") : "no files");

  const sandbox = {
    context,
    global,
    realm,
    timers,
    console: sandboxConsole,
    logs: capture ? capture.entries : null,
    sessionStorage,
    localStorage,
    files,

    /** Reads each file from disk and runs it unchanged in this context, in order. */
    load(...paths) {
      for (const relative of paths.flat()) {
        const file = path.resolve(root, String(relative));
        let code;
        try {
          code = fs.readFileSync(file, "utf8");
        } catch (error) {
          throw new Error(`FormScriptKit: cannot read ${file}: ${error.message}`, { cause: error });
        }
        if (code.charCodeAt(0) === 0xfeff) code = code.slice(1);
        try {
          vm.runInContext(code, context, { filename: file });
        } catch (error) {
          const message = error && error.message !== undefined ? error.message : String(error);
          throw new Error(`FormScriptKit: ${file} threw while loading: ${message}`, { cause: error });
        }
        files.push(file);
      }
      return sandbox;
    },

    /** Runs a string in the context and returns its completion value. */
    run(code, filename = "inline.js") {
      return vm.runInContext(String(code), context, { filename });
    },

    /** Adds or replaces a global. Call before load() for scripts that read it at load time. */
    define(name, value) {
      if (typeof name !== "string" || !IDENTIFIER.test(name)) {
        throw new TypeError(`FormScriptKit: define() needs an identifier; got ${JSON.stringify(name)}`);
      }
      context[name] = value;
      return sandbox;
    },

    /** Evaluates an expression in the context; sees var, function, const, let and class bindings. */
    get(expression) {
      return vm.runInContext(String(expression), context, { filename: "get.js" });
    },

    /**
     * Resolves a dotted name such as "KhQuoteDiscount.onLoad" to a function
     * bound to its owner. The name must match a dotted-identifier pattern.
     * Only its first segment is evaluated, as a bare identifier, so top-level
     * const, let and class bindings resolve; the remaining segments are
     * property reads. The string is never evaluated as arbitrary code.
     */
    fn(dottedName) {
      if (typeof dottedName !== "string" || !DOTTED_NAME.test(dottedName)) {
        throw new TypeError(
          `FormScriptKit: ${JSON.stringify(dottedName)} is not a dotted name such as KhQuoteDiscount.onLoad`,
        );
      }
      const segments = dottedName.split(".");
      const missing = (segment) =>
        new Error(
          `FormScriptKit: "${dottedName}" does not resolve: "${segment}" is undefined after loading ${loadedNames()}`,
        );

      let value;
      try {
        value = vm.runInContext(`typeof ${segments[0]} === "undefined" ? undefined : ${segments[0]}`, context, {
          filename: "fn.js",
        });
      } catch {
        value = undefined;
      }
      if (value === undefined || value === null) throw missing(segments[0]);

      let owner = global;
      for (const segment of segments.slice(1)) {
        owner = value;
        value = value[segment];
        if (value === undefined || value === null) throw missing(segment);
      }
      if (typeof value !== "function") {
        throw new TypeError(`FormScriptKit: "${dottedName}" is not a function`);
      }
      return Function.prototype.bind.call(value, owner);
    },
  };

  for (const [name, value] of Object.entries(globals)) sandbox.define(name, value);
  return sandbox;
}

/** createSandbox(options).load(...files) */
function loadWebResources(files, options) {
  return createSandbox(options).load(...[].concat(files));
}

module.exports = { createSandbox, loadWebResources };
