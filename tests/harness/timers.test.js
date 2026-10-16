"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTimers } = require("../../harness");

test("nothing runs until asked", () => {
  const timers = createTimers();
  const ran = [];
  const first = timers.setTimeout(() => ran.push("timeout"), 10);
  const second = timers.setInterval(() => ran.push("interval"), 5);

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(timers.pending, 2);
  assert.equal(timers.now, 0);
  assert.deepEqual(ran, []);
});

test("next runs by due time, then by scheduling order", () => {
  const timers = createTimers();
  const ran = [];
  timers.setTimeout(() => ran.push("late"), 20);
  timers.setTimeout(() => ran.push("first"), 5);
  timers.setTimeout(() => ran.push("second"), 5);

  assert.equal(timers.next(), true);
  assert.deepEqual(ran, ["first"]);
  assert.equal(timers.now, 5);
  timers.next();
  assert.deepEqual(ran, ["first", "second"]);
  assert.equal(timers.now, 5);
  timers.next();
  assert.equal(timers.now, 20);
  assert.equal(timers.next(), false);
  assert.deepEqual(ran, ["first", "second", "late"]);
});

test("advance runs due timers and repeats intervals; clear cancels", () => {
  const timers = createTimers();
  const seen = [];
  const tick = timers.setInterval((label) => seen.push(`${label}@${timers.now}`), 10, "tick");
  timers.setTimeout((a, b) => seen.push(`once:${a}+${b}@${timers.now}`), 15, 1, 2);
  const cancelled = timers.setTimeout(() => seen.push("never"), 5);
  timers.clearTimeout(cancelled);

  assert.equal(timers.advance(30), 4);
  assert.deepEqual(seen, ["tick@10", "once:1+2@15", "tick@20", "tick@30"]);
  assert.equal(timers.now, 30);

  timers.clearTimeout(tick); // clearTimeout and clearInterval are interchangeable
  timers.clearInterval(999); // unknown handles are ignored
  assert.equal(timers.advance(100), 0);
  assert.equal(timers.pending, 0);
  assert.equal(timers.now, 130);
});

test("runAll gives up on a live interval", () => {
  const timers = createTimers();
  timers.setInterval(() => {}, 0); // clamped to 1 ms, so it can't spin in place
  assert.throws(() => timers.runAll({ limit: 50 }), /FormScriptKit: timers did not settle after 50 runs/);

  const finite = createTimers();
  const order = [];
  finite.setTimeout(() => {
    order.push("a");
    finite.setTimeout(() => order.push("c"), 100);
  }, 10);
  finite.setTimeout(() => order.push("b"), 20);
  assert.equal(finite.runAll(), 3);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(finite.now, 110);
});

test("flush runs zero-delay chains across promise hops but leaves delayed timers", async () => {
  const timers = createTimers();
  const steps = [];
  timers.setTimeout(async () => {
    steps.push("first");
    await Promise.resolve();
    await null;
    steps.push("after the awaits");
    timers.setTimeout(() => steps.push("second"), 0);
  }, 0);
  timers.setTimeout(() => steps.push("delayed"), 1000);

  assert.equal(await timers.flush(), 2);
  assert.deepEqual(steps, ["first", "after the awaits", "second"]);
  assert.equal(timers.pending, 1);
  assert.equal(timers.now, 0);

  const looping = createTimers();
  const again = () => looping.setTimeout(again, 0);
  again();
  await assert.rejects(looping.flush({ limit: 10 }), /did not settle after 10 runs/);
});

test("a string callback is refused", () => {
  const timers = createTimers();
  assert.throws(() => timers.setTimeout("khRun()", 0), /timer callbacks must be functions/);
  assert.throws(() => timers.setInterval("khRun()", 10), /timer callbacks must be functions/);
  assert.equal(timers.pending, 0);
});

test("a throwing timer callback reaches the test", async () => {
  const timers = createTimers();
  timers.setTimeout(() => {
    throw new Error("timer broke");
  }, 0);
  assert.throws(() => timers.next(), /timer broke/);

  timers.setTimeout(() => {
    throw new Error("flushed timer broke");
  }, 0);
  await assert.rejects(timers.flush(), /flushed timer broke/);
});
