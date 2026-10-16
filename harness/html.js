"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createDocument, dispatch, addListener, removeListener, parseAttributes, blankComments } = require("./dom");
const { createTimers } = require("./timers");
const { createStorage } = require("./storage");
const { createConsole, CONSOLE_LEVELS } = require("./console");

// Runs the script blocks of an HTML web resource, as shipped, against the
// fake DOM built from the same file. Errors point at the HTML file's lines.

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const EXECUTABLE_TYPES = new Set(["", "text/javascript", "application/javascript"]);
const CLIENT_URL = "https://contoso.crm.dynamics.com";
const PAGE_OPTIONS = new Set(["data", "search", "sessionStorage", "localStorage", "host", "console", "scripts"]);

function scriptKind(type) {
  return type === null ? "" : type.split(";")[0].trim().toLowerCase();
}

/**
 * Finds every <script> block outside comments, in document order:
 * [{ code, src, type, line }], where `line` is the 1-based line `code` starts on.
 * type="module" throws; other non-JavaScript types are returned but never run.
 */
function extractScripts(html) {
  const source = blankComments(String(html));
  const scripts = [];
  SCRIPT_BLOCK.lastIndex = 0;
  for (let match = SCRIPT_BLOCK.exec(source); match; match = SCRIPT_BLOCK.exec(source)) {
    const attributes = parseAttributes(match[1]);
    const type = attributes.has("type") ? attributes.get("type") : null;
    if (scriptKind(type) === "module") {
      throw new Error('FormScriptKit: <script type="module"> is not supported; web resources here are classic scripts');
    }
    const codeStart = match.index + match[0].indexOf(">") + 1;
    const before = source.slice(0, codeStart);
    scripts.push({
      code: match[2],
      src: attributes.has("src") ? attributes.get("src") : null,
      type,
      line: before.split("\n").length,
    });
  }
  return scripts;
}

function isExecutable(script) {
  return EXECUTABLE_TYPES.has(scriptKind(script.type));
}

function readText(file) {
  const text = fs.readFileSync(file, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Opens an HTML web resource: builds the fake DOM from its markup, runs its
 * executable scripts in one vm context whose global is the page's window,
 * then fires DOMContentLoaded and load.
 */
function openHtmlWebResource(file, options = {}) {
  for (const key of Object.keys(options)) {
    if (!PAGE_OPTIONS.has(key)) throw new TypeError(`FormScriptKit: openHtmlWebResource has no option "${key}"`);
  }
  const {
    data,
    search: rawSearch,
    sessionStorage = createStorage(),
    localStorage = createStorage(),
    host = {},
    console: consoleOption = "capture",
    scripts: scriptMap = {},
  } = options;
  if (data !== undefined && typeof data !== "string") {
    throw new TypeError("FormScriptKit: the data option is a string, as navigateTo passes it");
  }

  const htmlFile = path.resolve(String(file));
  const html = readText(htmlFile);
  const scripts = extractScripts(html);
  const document = createDocument(html);
  const timers = createTimers();
  const capture = consoleOption === "capture" ? createConsole() : null;
  const pageConsole = capture || consoleOption;
  if (CONSOLE_LEVELS.some((level) => !pageConsole || typeof pageConsole[level] !== "function")) {
    throw new TypeError('FormScriptKit: the console option is "capture" or a console-like object');
  }

  let search = "";
  if (rawSearch !== undefined) {
    search = String(rawSearch);
    if (search !== "" && !search.startsWith("?")) search = "?" + search;
  } else if (data !== undefined) {
    search = "?data=" + encodeURIComponent(data);
  }

  const state = { closed: false, closeCalls: 0 };
  const skippedScripts = [];

  const context = vm.createContext({});
  const window = vm.runInContext("globalThis", context);
  vm.runInContext("globalThis.window = globalThis.self = globalThis;", context);
  Object.assign(context, {
    document,
    location: {
      search,
      href: `${CLIENT_URL}/WebResources/${path.basename(htmlFile)}${search}`,
      origin: CLIENT_URL,
    },
    sessionStorage,
    localStorage,
    console: pageConsole,
    parent: host,
    top: host,
    closed: false,
    close() {
      state.closeCalls += 1;
      state.closed = true;
      context.closed = true;
    },
    addEventListener: (type, listener) => addListener(window, type, listener),
    removeEventListener: (type, listener) => removeListener(window, type, listener),
    setTimeout: (callback, ms, ...args) => timers.setTimeout(callback, ms, ...args),
    clearTimeout: (handle) => timers.clearTimeout(handle),
    setInterval: (callback, ms, ...args) => timers.setInterval(callback, ms, ...args),
    clearInterval: (handle) => timers.clearInterval(handle),
    URL,
    URLSearchParams,
  });

  const run = (code, filename, lineOffset = 0, columnOffset = 0) => {
    try {
      vm.runInContext(code, context, { filename, lineOffset, columnOffset });
    } catch (error) {
      const where = lineOffset > 0 ? `${filename} (script starting on line ${lineOffset + 1})` : filename;
      const message = error && error.message !== undefined ? error.message : String(error);
      throw new Error(`FormScriptKit: ${where} threw while loading: ${message}`, { cause: error });
    }
  };

  const htmlLines = html.split("\n");
  document.readyState = "loading";
  for (const script of scripts) {
    if (!isExecutable(script)) continue;
    if (script.src !== null) {
      if (!Object.hasOwn(scriptMap, script.src)) {
        skippedScripts.push(script.src);
        continue;
      }
      const external = path.resolve(String(scriptMap[script.src]));
      run(readText(external), external);
      continue;
    }
    // The code starts mid-line, right after the opening tag; tell vm where.
    const startLine = htmlLines[script.line - 1] || "";
    const lastOpen = startLine.toLowerCase().lastIndexOf("<script");
    const column = lastOpen >= 0 ? startLine.indexOf(">", lastOpen) + 1 : 0;
    run(script.code, htmlFile, script.line - 1, column);
  }
  document.readyState = "complete";
  dispatch(document, "DOMContentLoaded");
  dispatch(window, "load");

  function el(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`FormScriptKit: ${path.basename(htmlFile)} has no element with id "${id}"`);
    return element;
  }

  return {
    window,
    document,
    timers,
    logs: capture ? capture.entries : null,
    skippedScripts,
    sessionStorage,
    localStorage,
    get closed() {
      return state.closed;
    },
    get closeCalls() {
      return state.closeCalls;
    },
    el,
    /** element.click(): nothing happens on a disabled element. */
    click(id) {
      el(id).click();
    },
    /** Sets the value, then dispatches input and change. */
    type(id, value) {
      const element = el(id);
      element.value = value;
      dispatch(element, "input");
      dispatch(element, "change");
    },
    dispatch(id, type, props) {
      return dispatch(el(id), type, props);
    },
  };
}

module.exports = { extractScripts, openHtmlWebResource };
