"use strict";

// A vm context has its own Object, Array, Date and Promise. Objects built by
// sandbox code fail assert.deepStrictEqual against literals written in a test,
// because their prototypes differ. Everything here moves values across that
// boundary by copying, plus a few small helpers shared by the fakes.

/** The test's own intrinsics, in the same shape as a sandbox realm. */
const HOST_REALM = Object.freeze({
  Object,
  Array,
  Date,
  Promise,
  Error,
  TypeError,
  SyntaxError,
});

const tagOf = (value) => Object.prototype.toString.call(value);

/**
 * Deep copy `value` using the constructors of `realm`.
 * Primitives (and a top-level function) come back as they are. Dates and
 * arrays are rebuilt in the realm; other objects become plain realm objects
 * with their own enumerable string-keyed properties, minus functions. Errors
 * keep `name` and `message` (and a non-enumerable `stack`). Cycles are kept.
 */
function copyInto(value, realm, memo = new Map()) {
  if (!realm || typeof realm.Object !== "function") {
    throw new TypeError("FormScriptKit: copyInto needs a realm such as sandbox.realm");
  }
  return copyValue(value, realm, memo);
}

function copyValue(value, realm, memo) {
  if (value === null || typeof value !== "object") return value;
  if (memo.has(value)) return memo.get(value);

  const tag = tagOf(value);
  if (tag === "[object Date]") {
    const date = new realm.Date(Date.prototype.getTime.call(value));
    memo.set(value, date);
    return date;
  }
  if (Array.isArray(value)) {
    const list = new realm.Array();
    memo.set(value, list);
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      list.push(typeof item === "function" ? undefined : copyValue(item, realm, memo));
    }
    return list;
  }

  const copy = new realm.Object();
  memo.set(value, copy);
  const isError = tag === "[object Error]";
  if (isError) {
    copy.name = String(value.name);
    copy.message = String(value.message);
  }
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === "function") continue;
    copy[key] = copyValue(item, realm, memo);
  }
  if (isError && typeof value.stack === "string") {
    Object.defineProperty(copy, "stack", {
      value: value.stack,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/** copyInto(value, <the test's own intrinsics>). */
function toHost(value) {
  return copyInto(value, HOST_REALM);
}

/**
 * A bare lowercase GUID built at runtime from an integer, for fixtures.
 * fakeGuid(42) ends in ...00000000002a.
 */
function fakeGuid(n) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError("FormScriptKit: fakeGuid needs a non-negative integer");
  }
  return "00000000-0000-0000-0000-" + n.toString(16).padStart(12, "0");
}

/** "{" + upper-case GUID + "}", the form getId() and lookup values use. */
function bracedId(guid) {
  return "{" + String(guid).replace(/[{}]/g, "").toUpperCase() + "}";
}

/** Strips braces and lowercases, the form Web API URLs use. */
function bareId(id) {
  return String(id).replace(/[{}]/g, "").toLowerCase();
}

/** { promise, resolve, reject } (Node 20 has no Promise.withResolvers). */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The { errorCode, message } shape Client API error callbacks receive. */
function xrmError(message, errorCode = null) {
  return { errorCode, message: String(message) };
}

const STATUS_TEXT = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  412: "Precondition Failed",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

const RESPONSE_PARTS = new WeakMap();

/**
 * Builds a fetch-style response in `realm`: { ok, status, statusText, url,
 * headers, json(), text() }. json() parses the JSON text like a real body
 * would, and rejects with a SyntaxError when there is no body.
 */
function buildResponse(parts, realm = HOST_REALM) {
  const hasBody = parts.body !== undefined;
  const text = hasBody ? JSON.stringify(parts.body) : "";
  const SyntaxErrorType = realm.SyntaxError || SyntaxError;
  const response = new realm.Object();
  response.ok = parts.status >= 200 && parts.status < 300;
  response.status = parts.status;
  response.statusText = parts.statusText;
  response.url = parts.url || "";
  response.headers = new realm.Object();
  response.json = function json() {
    return new realm.Promise((resolve, reject) => {
      if (!hasBody) {
        reject(new SyntaxErrorType("Unexpected end of JSON input"));
        return;
      }
      resolve(copyInto(JSON.parse(text), realm));
    });
  };
  response.text = function textBody() {
    return new realm.Promise((resolve) => resolve(text));
  };
  RESPONSE_PARTS.set(response, parts);
  return response;
}

/**
 * An explicit Xrm.WebApi.online.execute response, for a responder that needs
 * a status other than the defaults (200 with a body, 204 without one).
 */
function xrmResponse(body, { status = 200, statusText } = {}) {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("FormScriptKit: xrmResponse needs an HTTP status between 100 and 599");
  }
  const text = statusText === undefined ? STATUS_TEXT[status] || "" : String(statusText);
  return buildResponse({ status, statusText: text, body: body === undefined ? undefined : toHost(body) });
}

/** The parts an xrmResponse was built from, or null for any other value. */
function responseParts(value) {
  return value !== null && typeof value === "object" ? RESPONSE_PARTS.get(value) || null : null;
}

/** An Error of the given kind from `realm` (or the host), prefixed "FormScriptKit: ". */
function harnessError(realm, message, kind = "TypeError") {
  const Kind = (realm && realm[kind]) || HOST_REALM[kind] || Error;
  return new Kind("FormScriptKit: " + message);
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

/**
 * A Client API style collection over a live list of items:
 * get() -> all, get(name) -> item or null, get(index) -> item or null,
 * get(delegate) -> filtered array, forEach(delegate), getLength().
 * Arrays handed out are built in `realm` when one is given.
 */
function createCollection(listItems, { realm = null, nameOf = (item) => item.getName() } = {}) {
  const toArray = (items) => (realm ? realm.Array.from(items) : items.slice());
  return {
    get(arg) {
      const items = listItems();
      if (arg === undefined) return toArray(items);
      if (typeof arg === "string") return items.find((item) => nameOf(item) === arg) || null;
      if (typeof arg === "number") return Number.isInteger(arg) && items[arg] ? items[arg] : null;
      if (typeof arg === "function") return toArray(items.filter((item, index) => arg(item, index)));
      throw harnessError(realm, "collection.get() takes nothing, a name, an index or a function");
    },
    forEach(delegate) {
      if (typeof delegate !== "function") {
        throw harnessError(realm, "collection.forEach() needs a function");
      }
      listItems().slice().forEach((item, index) => delegate(item, index));
    },
    getLength() {
      return listItems().length;
    },
  };
}

module.exports = {
  HOST_REALM,
  copyInto,
  toHost,
  fakeGuid,
  bracedId,
  bareId,
  deferred,
  xrmError,
  xrmResponse,
  buildResponse,
  responseParts,
  harnessError,
  isThenable,
  createCollection,
};
