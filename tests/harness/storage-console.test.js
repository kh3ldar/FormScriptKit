"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStorage, createConsole } = require("../../harness");

test("storage follows Web Storage semantics", () => {
  const storage = createStorage();
  storage.setItem("count", 3);
  storage.setItem("flag", true);
  storage.setItem("shape", { a: 1 });

  assert.equal(storage.getItem("count"), "3");
  assert.equal(storage.getItem("flag"), "true");
  assert.equal(storage.getItem("shape"), "[object Object]");
  assert.equal(storage.getItem("missing"), null);
  assert.equal(storage.length, 3);
  assert.equal(storage.key(0), "count");
  assert.equal(storage.key(7), null);

  storage.removeItem("count");
  storage.removeItem("never-set");
  assert.deepEqual(storage.snapshot(), { flag: "true", shape: "[object Object]" });
  storage.clear();
  assert.equal(storage.length, 0);
  assert.deepEqual(storage.snapshot(), {});
});

test("blocked storage throws on every access", () => {
  const storage = createStorage();
  storage.setItem("kept", "yes");
  storage.blocked = true;

  const accesses = [
    () => storage.getItem("kept"),
    () => storage.setItem("other", "no"),
    () => storage.removeItem("kept"),
    () => storage.clear(),
    () => storage.key(0),
    () => storage.length,
  ];
  for (const access of accesses) {
    assert.throws(access, { name: "SecurityError", message: "FormScriptKit: storage is blocked" });
  }
  assert.deepEqual(storage.snapshot(), { kept: "yes" }, "the test can still look");

  storage.blocked = false;
  assert.equal(storage.getItem("kept"), "yes");
});

test("the capture console records levels and host-copied arguments", () => {
  const capture = createConsole();
  const record = { count: 1, when: new Date(10) };
  capture.log("plain", 1);
  capture.info(record);
  capture.debug();
  capture.error(new RangeError("out of range"));
  record.count = 2;

  assert.deepStrictEqual(capture.entries, [
    { level: "log", args: ["plain", 1] },
    { level: "info", args: [{ count: 1, when: new Date(10) }] },
    { level: "debug", args: [] },
    { level: "error", args: [{ name: "RangeError", message: "out of range" }] },
  ]);
  assert.notEqual(capture.entries[1].args[0], record, "arguments are copied at the moment of the call");
  capture.warn("last");
  assert.equal(capture.entries.at(-1).level, "warn");
});
