"use strict";

const {
  HOST_REALM,
  copyInto,
  toHost,
  bareId,
  harnessError,
  isThenable,
  createCollection,
} = require("./realm");

// Typed form attributes: declaration shorthands, value validation, the
// equality that decides "dirty", and the Xrm-shaped attribute object.

const ATTRIBUTE_TYPES = Object.freeze([
  "string",
  "memo",
  "integer",
  "decimal",
  "double",
  "money",
  "boolean",
  "optionset",
  "lookup",
  "datetime",
]);
const REQUIRED_LEVELS = Object.freeze(["none", "required", "recommended"]);
const SUBMIT_MODES = Object.freeze(["always", "never", "dirty"]);
const SPEC_KEYS = new Set([
  "type",
  "value",
  "requiredLevel",
  "submitMode",
  "options",
  "label",
  "visible",
  "disabled",
  "controls",
]);

const isDate = (value) => Object.prototype.toString.call(value) === "[object Date]";
const timeOf = (date) => Date.prototype.getTime.call(date);

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (isDate(value)) return "a Date";
  if (typeof value === "function") return "a function";
  return "an object";
}

/**
 * Turns a declaration into a full spec. Shorthands: a string is "string", a
 * boolean is "boolean", a Date is "datetime", an array is "lookup". A bare
 * number or null is refused, because five types hold numbers.
 */
function normaliseAttributeSpec(name, input) {
  if (typeof input === "string") return completeSpec(name, { type: "string", value: input });
  if (typeof input === "boolean") return completeSpec(name, { type: "boolean", value: input });
  if (isDate(input)) return completeSpec(name, { type: "datetime", value: input });
  if (Array.isArray(input)) return completeSpec(name, { type: "lookup", value: input });
  if (typeof input === "number" || input === null) {
    throw new TypeError(
      `FormScriptKit: attribute "${name}": a bare ${describe(input)} doesn't say which type it is ` +
        "(integer, decimal, double, money and optionset all hold numbers); declare { type, value }",
    );
  }
  if (input !== null && typeof input === "object") return completeSpec(name, input);
  throw new TypeError(`FormScriptKit: attribute "${name}": cannot declare an attribute from ${describe(input)}`);
}

function completeSpec(name, input) {
  const fail = (message) => new TypeError(`FormScriptKit: attribute "${name}": ${message}`);
  for (const key of Object.keys(input)) {
    if (!SPEC_KEYS.has(key)) throw fail(`unknown option "${key}"`);
  }
  if (!ATTRIBUTE_TYPES.includes(input.type)) {
    throw fail(`type must be one of ${ATTRIBUTE_TYPES.join(", ")}; got ${describe(input.type)}`);
  }
  const spec = {
    type: input.type,
    value: input.value === undefined ? null : input.value,
    requiredLevel: input.requiredLevel === undefined ? "none" : input.requiredLevel,
    submitMode: input.submitMode === undefined ? "dirty" : input.submitMode,
    options: null,
    label: input.label === undefined ? name : input.label,
    visible: input.visible === undefined ? true : input.visible,
    disabled: input.disabled === undefined ? false : input.disabled,
    controls: [name],
  };
  if (!REQUIRED_LEVELS.includes(spec.requiredLevel)) {
    throw fail(`requiredLevel must be one of ${REQUIRED_LEVELS.join(", ")}`);
  }
  if (!SUBMIT_MODES.includes(spec.submitMode)) throw fail(`submitMode must be one of ${SUBMIT_MODES.join(", ")}`);
  if (typeof spec.label !== "string") throw fail("label must be a string");
  if (typeof spec.visible !== "boolean") throw fail("visible must be true or false");
  if (typeof spec.disabled !== "boolean") throw fail("disabled must be true or false");

  if (input.options !== undefined) {
    if (spec.type !== "optionset") throw fail("options only apply to optionset attributes");
    if (!Array.isArray(input.options)) throw fail("options must be an array of { value, text }");
    spec.options = input.options.map((option, index) => {
      if (!option || !Number.isInteger(option.value) || typeof option.text !== "string") {
        throw fail(`option ${index} needs an integer value and a string text`);
      }
      return { value: option.value, text: option.text };
    });
  }

  if (input.controls === false) {
    spec.controls = [];
  } else if (input.controls !== undefined) {
    if (!Array.isArray(input.controls) || input.controls.some((c) => typeof c !== "string" || c === "")) {
      throw fail("controls must be an array of control names, or false");
    }
    spec.controls = input.controls.slice();
  }

  const problem = checkValue(spec, spec.value);
  if (problem) throw fail(`its value ${problem}`);
  return spec;
}

function checkLookup(value) {
  if (!Array.isArray(value)) return `needs an array of { id, entityType, name } or null; got ${describe(value)}`;
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (item === null || typeof item !== "object") return `needs objects in the array; item ${i} is ${describe(item)}`;
    if (typeof item.id !== "string") return `needs a string id on item ${i}`;
    if (typeof item.entityType !== "string") return `needs a string entityType on item ${i}`;
    if (item.name !== undefined && item.name !== null && typeof item.name !== "string") {
      return `needs name to be a string on item ${i}`;
    }
  }
  return null;
}

/** Returns why `value` doesn't fit the spec's type, or null when it does. */
function checkValue(spec, value) {
  const { type } = spec;
  if (value === null) return type === "boolean" ? "takes true or false; null is not allowed for a boolean" : null;
  switch (type) {
    case "string":
    case "memo":
      return typeof value === "string" ? null : `needs a string or null; got ${describe(value)}`;
    case "integer":
      return Number.isInteger(value) ? null : `needs a whole number or null; got ${describe(value)}`;
    case "decimal":
    case "double":
    case "money":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `needs a finite number or null; got ${describe(value)}`;
    case "optionset":
      if (!Number.isInteger(value)) return `needs an integer option value or null; got ${describe(value)}`;
      if (spec.options && !spec.options.some((option) => option.value === value)) {
        return `needs one of its option values (${spec.options.map((o) => o.value).join(", ")}); got ${value}`;
      }
      return null;
    case "boolean":
      return value === true || value === false ? null : `takes true or false; got ${describe(value)}`;
    case "datetime":
      return isDate(value) && !Number.isNaN(timeOf(value)) ? null : `needs a valid Date or null; got ${describe(value)}`;
    case "lookup":
      return checkLookup(value);
    default:
      return `has an unknown type ${describe(type)}`;
  }
}

/**
 * The equality behind getIsDirty(): === for scalars, getTime() for dates,
 * and for lookups the same length with matching entityType and ids compared
 * without braces or case.
 */
function sameValue(type, a, b) {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty || bEmpty) return aEmpty && bEmpty;
  if (type === "datetime") return timeOf(a) === timeOf(b);
  if (type === "lookup") {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].entityType !== b[i].entityType) return false;
      if (bareId(a[i].id) !== bareId(b[i].id)) return false;
    }
    return true;
  }
  return a === b;
}

/**
 * Builds one attribute. `env` supplies { realm, getFormContext, recordError }.
 * Returns the harness-side state; `state.attribute` is the Xrm-shaped object.
 */
function createAttributeState(name, declaration, env) {
  const spec = normaliseAttributeSpec(name, declaration);
  const realm = env.realm || null;
  const handOver = (value) => copyInto(value, realm || HOST_REALM);
  const refuse = (problem) => harnessError(realm, `setValue on ${name} (${spec.type}) ${problem}`);

  const state = {
    name,
    type: spec.type,
    spec,
    value: handOver(spec.value),
    baseline: toHost(spec.value),
    requiredLevel: spec.requiredLevel,
    submitMode: spec.submitMode,
    handlers: [],
    controls: [],
    attribute: null,

    isDirty() {
      return !sameValue(spec.type, state.value, state.baseline);
    },
    /** Sets a value supplied by the test (validated, copied into the sandbox realm). */
    assign(value) {
      const problem = checkValue(spec, value);
      if (problem) throw new TypeError(`FormScriptKit: ${name} (${spec.type}) ${problem}`);
      state.value = handOver(value);
    },
    /** The current value becomes the loaded value (after a save or a refresh). */
    commit() {
      state.baseline = toHost(state.value);
    },
    fireOnChange() {
      const executionContext = {
        getFormContext: () => env.getFormContext(),
        getEventSource: () => attribute,
        getEventArgs: () => null,
      };
      for (const handler of state.handlers.slice()) {
        try {
          const result = handler(executionContext);
          if (isThenable(result)) {
            Promise.resolve(result).catch((error) => env.recordError({ event: "onchange", attribute: name, error }));
          }
        } catch (error) {
          env.recordError({ event: "onchange", attribute: name, error });
        }
      }
    },
  };

  const attribute = {
    getName: () => name,
    getAttributeType: () => spec.type,
    getValue: () => state.value,
    setValue(value) {
      const problem = checkValue(spec, value);
      if (problem) throw refuse(problem);
      state.value = value;
    },
    getIsDirty: () => state.isDirty(),
    addOnChange(handler) {
      if (typeof handler !== "function") throw harnessError(realm, `${name}.addOnChange() needs a function`);
      state.handlers.push(handler);
    },
    removeOnChange(handler) {
      state.handlers = state.handlers.filter((registered) => registered !== handler);
    },
    fireOnChange: () => state.fireOnChange(),
    getRequiredLevel: () => state.requiredLevel,
    setRequiredLevel(level) {
      if (!REQUIRED_LEVELS.includes(level)) {
        throw harnessError(realm, `setRequiredLevel() takes ${REQUIRED_LEVELS.join(", ")}; got ${describe(level)}`);
      }
      state.requiredLevel = level;
    },
    getSubmitMode: () => state.submitMode,
    setSubmitMode(mode) {
      if (!SUBMIT_MODES.includes(mode)) {
        throw harnessError(realm, `setSubmitMode() takes ${SUBMIT_MODES.join(", ")}; got ${describe(mode)}`);
      }
      state.submitMode = mode;
    },
    controls: createCollection(() => state.controls, { realm }),
  };

  if (spec.type === "optionset") {
    const selected = () => {
      if (state.value === null) return null;
      const option = (spec.options || []).find((candidate) => candidate.value === state.value);
      return option || null;
    };
    attribute.getText = () => {
      const option = selected();
      return option ? option.text : null;
    };
    attribute.getSelectedOption = () => {
      const option = selected();
      return option ? handOver({ value: option.value, text: option.text }) : null;
    };
  }

  state.attribute = attribute;
  return state;
}

module.exports = {
  ATTRIBUTE_TYPES,
  REQUIRED_LEVELS,
  SUBMIT_MODES,
  normaliseAttributeSpec,
  checkValue,
  sameValue,
  createAttributeState,
};
