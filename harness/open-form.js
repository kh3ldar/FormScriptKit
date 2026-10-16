"use strict";

const { createSandbox } = require("./sandbox");
const { createForm, AFTER_CREATE } = require("./form");
const { createXrm } = require("./xrm");
const { createTimers } = require("./timers");
const { isThenable, toHost } = require("./realm");
const { LOAD_STATE } = require("./constants");

// Wires a sandbox, a form, an Xrm fake and timers the way a form loads its
// libraries and binds its event handlers by name.

const FORM_KEYS = ["entityName", "id", "formType", "primaryAttribute", "attributes", "tabs", "asyncSaveHandlers"];
const OWN_KEYS = [
  "libraries",
  "root",
  "xrm",
  "globals",
  "sessionStorage",
  "localStorage",
  "console",
  "handlers",
  "onLoadAfterCreate",
];
const HANDLER_KEYS = ["onLoad", "onSave", "onChange"];

function nameList(value, what) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new TypeError(`FormScriptKit: handlers.${what} must be an array of dotted names`);
  }
  return value;
}

/**
 * Opens a form: loads `libraries` into one sandbox, injects the Xrm fake,
 * resolves every configured handler name before any handler runs, and
 * registers OnSave and OnChange handlers. OnLoad runs when the test calls
 * fireOnLoad(), so responders can be registered first, and again, with load
 * state 2, after a create form's first save (unless onLoadAfterCreate is
 * false), as Microsoft documents for the form OnLoad event.
 */
function openForm(options = {}) {
  for (const key of Object.keys(options)) {
    if (!FORM_KEYS.includes(key) && !OWN_KEYS.includes(key)) {
      throw new TypeError(`FormScriptKit: openForm has no option "${key}"`);
    }
  }
  const { libraries, root, xrm: xrmOptions = {}, globals = {}, handlers = {}, onLoadAfterCreate = true } = options;
  if (typeof onLoadAfterCreate !== "boolean") {
    throw new TypeError("FormScriptKit: openForm onLoadAfterCreate must be true or false");
  }
  if (!Array.isArray(libraries) || libraries.length === 0) {
    throw new TypeError("FormScriptKit: openForm needs libraries, a non-empty array of web resource paths");
  }
  for (const key of Object.keys(handlers)) {
    if (!HANDLER_KEYS.includes(key)) {
      throw new TypeError(`FormScriptKit: handlers has no event "${key}" (use ${HANDLER_KEYS.join(", ")})`);
    }
  }

  const timers = createTimers();
  const sandboxOptions = { timers };
  for (const key of ["root", "sessionStorage", "localStorage", "console"]) {
    if (options[key] !== undefined) sandboxOptions[key] = options[key];
  }
  const sandbox = createSandbox(sandboxOptions);

  const formOptions = { realm: sandbox.realm };
  for (const key of FORM_KEYS) {
    if (options[key] !== undefined) formOptions[key] = options[key];
  }
  // Bound late: the OnLoad runner below needs the form, and the form needs the hook.
  let runOnLoad = null;
  if (onLoadAfterCreate) formOptions[AFTER_CREATE] = () => runOnLoad(LOAD_STATE.SAVE);
  const form = createForm(formOptions);
  const xrm = createXrm({ ...xrmOptions, realm: sandbox.realm });

  sandbox.define("Xrm", xrm.Xrm);
  for (const [name, value] of Object.entries(globals)) sandbox.define(name, value);
  sandbox.load(...libraries);

  // Resolve everything first: a misspelt name fails here, before any handler runs.
  const onLoad = nameList(handlers.onLoad, "onLoad").map((name) => sandbox.fn(name));
  const onSave = nameList(handlers.onSave, "onSave").map((name) => sandbox.fn(name));
  const onChange = Object.entries(handlers.onChange || {}).map(([attributeName, names]) => {
    const attribute = form.attribute(attributeName);
    return { attribute, fns: nameList(names, `onChange.${attributeName}`).map((name) => sandbox.fn(name)) };
  });

  for (const fn of onSave) form.formContext.data.entity.addOnSave(fn);
  for (const { attribute, fns } of onChange) {
    for (const fn of fns) attribute.addOnChange(fn);
  }

  const recordLoadError = (error) => {
    form.scriptErrors.push({ event: "onload", error: toHost(error) });
  };

  const loads = [];
  runOnLoad = async (loadState) => {
    loads.push({ loadState });
    const formContext = form.formContext;
    const eventArgs = { getDataLoadState: () => loadState };
    const executionContext = {
      getFormContext: () => formContext,
      getEventArgs: () => eventArgs,
      getEventSource: () => formContext,
    };
    const pending = [];
    for (const fn of onLoad) {
      try {
        const result = fn(executionContext);
        if (isThenable(result)) pending.push(Promise.resolve(result).then(() => undefined, recordLoadError));
      } catch (error) {
        recordLoadError(error);
      }
    }
    await Promise.all(pending);
  };

  return {
    sandbox,
    form,
    xrm,
    timers,
    /** One `{ loadState }` entry per OnLoad run, in order. */
    loads,

    /** Runs the OnLoad handlers in order (load state 1) and waits for any promises they return. */
    fireOnLoad: () => runOnLoad(LOAD_STATE.INITIAL),

    /** timers.flush(): runs deferred zero-delay work and the promise chains it starts. */
    settle: () => timers.flush(),

    /** sandbox.fn(name)(...args) */
    call: (name, ...args) => sandbox.fn(name)(...args),
  };
}

module.exports = { openForm };
