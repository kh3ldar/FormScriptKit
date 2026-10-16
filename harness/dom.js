"use strict";

// A deliberately small DOM for HTML web resource dialogs, built from the
// page's own markup. Every tag with an id becomes an element, so renaming an
// id in the markup fails the test that uses it. There is no tree from markup,
// no CSS, no layout and no selectors; innerHTML and friends throw on purpose.

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const START_TAG = /<([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const BUILD_HINT = "build nodes with document.createElement() and set textContent instead";
const LOOKUP_HINT = "look elements up by id with document.getElementById() instead";

const blank = (text) => text.replace(/[^\n]/g, " ");

/** Replaces every character of each HTML comment except newlines with a space. */
function blankComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, blank);
}

function blankRawText(html) {
  return html.replace(
    /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (whole, open, tag, body, close) => open + blank(body) + close,
  );
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Parses the attribute part of a start tag into a Map of lower-case names to decoded values. */
function parseAttributes(text) {
  const attributes = new Map();
  ATTRIBUTE.lastIndex = 0;
  for (let match = ATTRIBUTE.exec(text); match; match = ATTRIBUTE.exec(text)) {
    const name = match[1].toLowerCase();
    const raw = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
    if (!attributes.has(name)) attributes.set(name, raw === undefined ? "" : decodeEntities(raw));
  }
  return attributes;
}

function unsupported(member, hint) {
  return new Error(`FormScriptKit fake DOM: ${member} is not supported; ${hint}`);
}

const listenerStore = new WeakMap();

function listenersOf(target, type) {
  let byType = listenerStore.get(target);
  if (!byType) {
    byType = new Map();
    listenerStore.set(target, byType);
  }
  if (!byType.has(type)) byType.set(type, []);
  return byType.get(type);
}

function addListener(target, type, listener) {
  if (typeof listener !== "function") return;
  const list = listenersOf(target, String(type));
  if (!list.includes(listener)) list.push(listener);
}

function removeListener(target, type, listener) {
  const list = listenersOf(target, String(type));
  const index = list.indexOf(listener);
  if (index >= 0) list.splice(index, 1);
}

/**
 * Dispatches an event at `target` and bubbles it through parentNode unless a
 * listener stops it. Errors thrown by listeners propagate to the caller.
 */
function dispatch(target, type, props = {}) {
  let stopped = false;
  const event = {
    type,
    target,
    currentTarget: null,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    ...props,
  };
  for (let node = target; node && !stopped; node = node.parentNode) {
    event.currentTarget = node;
    for (const listener of listenersOf(node, type).slice()) listener.call(node, event);
  }
  return event;
}

class FakeElement {
  #owner;
  #tag;
  #attributes;
  #text;
  #value;

  constructor(owner, tag, attributes = new Map(), text = "") {
    this.#owner = owner;
    this.#tag = tag.toLowerCase();
    this.#attributes = attributes;
    this.#text = text;
    this.#value = this.#tag === "textarea" ? text : null;
    this.style = {};
    this.children = [];
    this.parentNode = null;
  }

  get tagName() {
    return this.#tag.toUpperCase();
  }
  get nodeName() {
    return this.#tag.toUpperCase();
  }
  get ownerDocument() {
    return this.#owner;
  }

  #reflect(name, fallback = "") {
    return this.#attributes.has(name) ? this.#attributes.get(name) : fallback;
  }
  #toggle(name, on) {
    if (on) this.#attributes.set(name, "");
    else this.#attributes.delete(name);
  }

  get id() {
    return this.#reflect("id");
  }
  set id(value) {
    this.#attributes.set("id", String(value));
  }
  get className() {
    return this.#reflect("class");
  }
  set className(value) {
    this.#attributes.set("class", String(value));
  }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    const write = (list) => {
      element.className = list.join(" ");
    };
    return {
      add: (...added) => write([...new Set([...names(), ...added])]),
      remove: (...removed) => write(names().filter((name) => !removed.includes(name))),
      toggle(name, force) {
        const present = names().includes(name);
        const on = force === undefined ? !present : Boolean(force);
        if (on && !present) write([...names(), name]);
        if (!on && present) write(names().filter((candidate) => candidate !== name));
        return on;
      },
      contains: (name) => names().includes(name),
    };
  }
  get title() {
    return this.#reflect("title");
  }
  set title(value) {
    this.#attributes.set("title", String(value));
  }

  get textContent() {
    return this.#text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.#text = value === null || value === undefined ? "" : String(value);
  }

  get value() {
    return this.#tag === "textarea" ? this.#value : this.#reflect("value");
  }
  set value(value) {
    const text = value === null || value === undefined ? "" : String(value);
    if (this.#tag === "textarea") this.#value = text;
    else this.#attributes.set("value", text);
  }
  get type() {
    const declared = this.#attributes.get("type");
    if (declared) return declared.toLowerCase();
    if (this.#tag === "input") return "text";
    if (this.#tag === "button") return "submit";
    return "";
  }
  set type(value) {
    this.#attributes.set("type", String(value));
  }
  get checked() {
    return this.#attributes.has("checked");
  }
  set checked(on) {
    this.#toggle("checked", Boolean(on));
  }
  get disabled() {
    return this.#attributes.has("disabled");
  }
  set disabled(on) {
    this.#toggle("disabled", Boolean(on));
  }
  get hidden() {
    return this.#attributes.has("hidden");
  }
  set hidden(on) {
    this.#toggle("hidden", Boolean(on));
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.#attributes.has(key) ? this.#attributes.get(key) : null;
  }
  setAttribute(name, value) {
    this.#attributes.set(String(name).toLowerCase(), String(value));
  }
  removeAttribute(name) {
    this.#attributes.delete(String(name).toLowerCase());
  }
  hasAttribute(name) {
    return this.#attributes.has(String(name).toLowerCase());
  }

  appendChild(child) {
    if (!(child instanceof FakeElement)) {
      throw new TypeError("FormScriptKit fake DOM: appendChild() takes an element from document.createElement()");
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("FormScriptKit fake DOM: removeChild() was given a node that is not a child");
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, listener) {
    addListener(this, type, listener);
  }
  removeEventListener(type, listener) {
    removeListener(this, type, listener);
  }
  focus() {
    this.#owner.activeElement = this;
  }
  blur() {
    if (this.#owner.activeElement === this) this.#owner.activeElement = this.#owner.body;
  }
  /** Does nothing on a disabled element, otherwise dispatches "click". */
  click() {
    if (this.disabled) return;
    dispatch(this, "click");
  }

  get innerHTML() {
    throw unsupported("innerHTML", BUILD_HINT);
  }
  set innerHTML(value) {
    throw unsupported("innerHTML", BUILD_HINT);
  }
  get outerHTML() {
    throw unsupported("outerHTML", BUILD_HINT);
  }
  set outerHTML(value) {
    throw unsupported("outerHTML", BUILD_HINT);
  }
  insertAdjacentHTML() {
    throw unsupported("insertAdjacentHTML", BUILD_HINT);
  }
  querySelector() {
    throw unsupported("querySelector", LOOKUP_HINT);
  }
  querySelectorAll() {
    throw unsupported("querySelectorAll", LOOKUP_HINT);
  }
}

class FakeDocument {
  #byId;

  constructor(byId) {
    this.#byId = byId;
    this.title = "";
    this.readyState = "loading";
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
  }

  /** Elements from the markup only. */
  getElementById(id) {
    return this.#byId.get(String(id)) || null;
  }
  createElement(tag) {
    if (typeof tag !== "string" || !TAG_NAME.test(tag)) {
      throw new TypeError(`FormScriptKit fake DOM: createElement() needs a tag name; got ${JSON.stringify(tag)}`);
    }
    return new FakeElement(this, tag);
  }
  addEventListener(type, listener) {
    addListener(this, type, listener);
  }
  removeEventListener(type, listener) {
    removeListener(this, type, listener);
  }
  querySelector() {
    throw unsupported("document.querySelector", LOOKUP_HINT);
  }
  querySelectorAll() {
    throw unsupported("document.querySelectorAll", LOOKUP_HINT);
  }
  write() {
    throw unsupported("document.write", BUILD_HINT);
  }
  writeln() {
    throw unsupported("document.writeln", BUILD_HINT);
  }
}

/** Builds a document from markup: one element per tag with an id; duplicate ids throw. */
function createDocument(html) {
  const source = blankRawText(blankComments(String(html)));
  const byId = new Map();
  const document = new FakeDocument(byId);

  const title = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(source);
  document.title = title ? decodeEntities(title[1]).trim() : "";

  START_TAG.lastIndex = 0;
  for (let match = START_TAG.exec(source); match; match = START_TAG.exec(source)) {
    const tag = match[1].toLowerCase();
    const attributes = parseAttributes(match[2]);
    if (!attributes.has("id")) continue;
    const id = attributes.get("id");
    if (byId.has(id)) throw new Error(`FormScriptKit fake DOM: the markup has two elements with id "${id}"`);

    let text = "";
    const selfClosing = match[3] === "/";
    if (!VOID_TAGS.has(tag) && !selfClosing && tag !== "script" && tag !== "style") {
      const rest = source.slice(START_TAG.lastIndex);
      const next = rest.indexOf("<");
      if (next >= 0 && new RegExp(`^</${tag}\\s*>`, "i").test(rest.slice(next))) {
        text = decodeEntities(rest.slice(0, next));
      }
    }
    byId.set(id, new FakeElement(document, tag, attributes, text));
  }
  return document;
}

module.exports = {
  createDocument,
  dispatch,
  addListener,
  removeListener,
  parseAttributes,
  blankComments,
  decodeEntities,
};
