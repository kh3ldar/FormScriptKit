"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSandbox, loadWebResources, toHost, copyInto } = require("../../harness");

const fixture = (name) => path.join(__dirname, "..", "fixtures", name);
const THREE_FILES = ["globals-first.js", "namespace-second.js", "lexical-third.js"].map(fixture);

test("files load in order into one realm", () => {
  const sandbox = loadWebResources(THREE_FILES);

  assert.equal(sandbox.get("KhSample.shout()"), "HELLO!");
  assert.equal(sandbox.get("KhSample.greetingAtLoad"), "hello");
  assert.equal(sandbox.get("KH_LIMIT"), 3);
  assert.equal(typeof sandbox.get("KhCounter"), "function");
  assert.equal(sandbox.run("(() => { const c = new KhCounter(); for (let i = 0; i < 5; i++) c.next(); return c.value; })()"), 3);
  assert.deepEqual(sandbox.files, THREE_FILES);
});

test("load order matters, as it does on a form", () => {
  const reversed = [fixture("namespace-second.js"), fixture("globals-first.js")];
  assert.throws(() => loadWebResources(reversed), /khGreeting is not defined/);
});

test("window, self, top and parent are the sandbox global", () => {
  const sandbox = loadWebResources(THREE_FILES);

  sandbox.run("window.khFromWindow = 1");
  assert.equal(sandbox.get("khFromWindow"), 1);
  assert.equal(
    sandbox.get("window === globalThis && self === globalThis && top === globalThis && parent === globalThis"),
    true,
  );
  assert.equal(sandbox.get("KhSampleAlias"), sandbox.get("KhSample"));
  assert.equal(sandbox.global, sandbox.get("globalThis"));
});

test("fn resolves dotted names and names what is missing", () => {
  const sandbox = loadWebResources(THREE_FILES);

  assert.equal(sandbox.fn("KhSample.shout")(), "HELLO!");
  assert.equal(sandbox.fn("khShout")("quiet"), "QUIET!");
  sandbox.fn("KhSample.bump")();
  assert.equal(sandbox.get("KhSample.lastCount"), 1, "methods are bound to their owner");

  assert.throws(
    () => sandbox.fn("KhSample.nope"),
    (error) => {
      assert.match(error.message, /"KhSample\.nope" does not resolve/);
      assert.match(error.message, /"nope" is undefined/);
      assert.match(error.message, /after loading globals-first\.js, namespace-second\.js, lexical-third\.js/);
      return true;
    },
  );
  assert.throws(() => sandbox.fn("KhMissing.x"), /"KhMissing" is undefined after loading globals-first\.js/);
  assert.throws(() => sandbox.fn("KhSample.notAFunction"), /"KhSample\.notAFunction" is not a function/);
  assert.throws(() => sandbox.fn("a;b"), /not a dotted name/);
  assert.throws(() => sandbox.fn("KhSample..shout"), /not a dotted name/);
  assert.throws(() => createSandbox().fn("KhSample.shout"), /after loading no files/);
});

test("a load error names the file and keeps the cause", () => {
  const file = fixture("missing-dependency.js");
  assert.throws(
    () => createSandbox().load(file),
    (error) => {
      assert.ok(error.message.startsWith(`FormScriptKit: ${file} threw while loading: `), error.message);
      assert.match(error.message, /KhHelperNotLoaded is not defined/);
      assert.equal(error.cause.name, "ReferenceError");
      return true;
    },
  );
  assert.throws(() => createSandbox().load(fixture("no-such-file.js")), /FormScriptKit: cannot read/);
});

test("stack traces point at the file on disk", () => {
  const sandbox = loadWebResources(THREE_FILES);
  assert.throws(
    () => sandbox.fn("KhSample.fail")(),
    (error) => {
      assert.match(error.message, /KhSample\.fail was asked to fail/);
      assert.ok(error.stack.includes(fixture("namespace-second.js")), error.stack);
      return true;
    },
  );
});

test("each sandbox reads the file again", (t) => {
  const first = loadWebResources(THREE_FILES);
  const second = loadWebResources(THREE_FILES);
  first.fn("KhSample.bump")();
  first.fn("KhSample.bump")();
  assert.equal(second.fn("KhSample.bump")(), 1);
  assert.notEqual(first.get("KhSample"), second.get("KhSample"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "formscriptkit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kh_version.js");
  fs.writeFileSync(file, "var khVersion = 1;\n");
  const before = createSandbox().load(file);
  fs.writeFileSync(file, "﻿var khVersion = 2;\n");
  const after = createSandbox().load(file);
  assert.equal(before.get("khVersion"), 1);
  assert.equal(after.get("khVersion"), 2, "no cache, and a leading BOM is stripped");
});

test("console output is captured", () => {
  const sandbox = createSandbox();
  sandbox.run('console.warn("careful", { count: 2 }, [1, 2]); console.error(new TypeError("bad input"));');
  assert.deepStrictEqual(sandbox.logs, [
    { level: "warn", args: ["careful", { count: 2 }, [1, 2]] },
    { level: "error", args: [{ name: "TypeError", message: "bad input" }] },
  ]);

  const seen = [];
  const custom = { log: (...a) => seen.push(a), info() {}, warn() {}, error() {}, debug() {} };
  const plain = createSandbox({ console: custom });
  plain.run('console.log("to the custom console")');
  assert.equal(plain.logs, null);
  assert.deepEqual(seen, [["to the custom console"]]);
});

test("no Node globals are defined inside; URL and URLSearchParams are the host's", () => {
  const sandbox = createSandbox();
  for (const name of ["require", "process", "module", "document", "fetch"]) {
    assert.equal(sandbox.run(`typeof ${name}`), "undefined", name);
  }
  assert.equal(sandbox.get("URL"), URL);
  assert.equal(sandbox.get("URLSearchParams"), URLSearchParams);
  assert.equal(
    sandbox.run("[typeof setTimeout, typeof clearTimeout, typeof setInterval, typeof clearInterval].join()"),
    "function,function,function,function",
  );
  assert.equal(sandbox.run("typeof sessionStorage.getItem + typeof localStorage.setItem"), "functionfunction");
  assert.notEqual(sandbox.realm.Array, Array, "intrinsics are the context's own");

  sandbox.run("setTimeout(function () { globalThis.khFired = true; }, 0)");
  assert.equal(sandbox.timers.pending, 1, "timers are the fake set");
  assert.equal(sandbox.get("typeof khFired"), "undefined");
});

test("toHost makes sandbox objects comparable", () => {
  const sandbox = createSandbox();
  const expected = { name: "Northwind", when: new Date(0), visits: [new Date(1000), new Date(2000)] };
  const value = sandbox.run("({ name: 'Northwind', when: new Date(0), visits: [new Date(1000), new Date(2000)] })");

  assert.throws(() => assert.deepStrictEqual(value, expected), "different realms, different prototypes");
  assert.deepStrictEqual(toHost(value), expected);
  assert.deepStrictEqual(toHost(sandbox.run("({ keep: 1, drop: function () {} })")), { keep: 1 });

  const cyclic = toHost(sandbox.run("(() => { const node = { name: 'loop' }; node.self = node; return node; })()"));
  assert.equal(cyclic.name, "loop");
  assert.equal(cyclic.self, cyclic);

  const inside = copyInto({ list: [1, 2], at: new Date(5) }, sandbox.realm);
  assert.ok(inside.list instanceof sandbox.realm.Array);
  assert.ok(inside.at instanceof sandbox.realm.Date);
  assert.ok(!(inside.list instanceof Array));
  assert.equal(inside.at.getTime(), 5);
});
