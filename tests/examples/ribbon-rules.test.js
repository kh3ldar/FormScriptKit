"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { openForm, createForm, deferred, toHost, fakeGuid, bracedId, xrmError } = require("../../harness");

const EXAMPLES = path.join(__dirname, "..", "..", "examples");
const RULES = path.join(EXAMPLES, "ribbon-rules", "kh_quoteribbonrules.js");
const HELPERS = path.join(EXAMPLES, "form-helpers", "kh_formhelpers.js");
const QUOTE_ID = fakeGuid(42);
const POLL_MS = 5000;

const STATES = [
  { value: 0, text: "Draft" },
  { value: 1, text: "Active" },
  { value: 2, text: "Won" },
];

function openQuote({ state = 0, libraries = [RULES], attributes, ...overrides } = {}) {
  return openForm({
    libraries,
    entityName: "quote",
    id: QUOTE_ID,
    attributes: attributes || { name: "Northwind renewal", statecode: { type: "optionset", value: state, options: STATES } },
    handlers: { onLoad: ["KhQuoteRibbon.startLinePoll"] },
    ...overrides,
  });
}

const rule = (page, name) => page.call(`KhQuoteRibbon.${name}`, page.form.formContext);

// Answers the line-count query from a mutable count.
function lineCount(page, initial) {
  const state = { count: initial, fail: false, reads: 0 };
  page.xrm.webApi.respond("retrieveMultipleRecords", () => {
    state.reads += 1;
    if (state.fail) throw xrmError("Service unavailable.");
    return Array.from({ length: Math.min(state.count, 1) }, () => ({ quotedetailid: fakeGuid(1) }));
  });
  return state;
}

// One poll step: let the timer fire, then let the read finish.
async function pollOnce(page) {
  page.timers.advance(POLL_MS);
  await page.settle();
}

test("every rule states its policy", () => {
  const page = openQuote();
  assert.deepEqual(toHost(page.sandbox.global.KhQuoteRibbon.policies), {
    canSendForReview: "fail-closed",
    canWithdrawReview: "fail-open",
    canOverrideDiscount: "fail-closed",
  });
});

// ---- fail-closed: canSendForReview

test("canSendForReview is hidden until the line count is known, then follows it", async () => {
  const page = openQuote();
  const lines = lineCount(page, 3);
  assert.equal(rule(page, "canSendForReview"), false, "fail-closed: unknown hides the button");

  await page.fireOnLoad();
  await page.settle();
  assert.equal(rule(page, "canSendForReview"), true);

  lines.count = 0;
  await pollOnce(page);
  assert.equal(rule(page, "canSendForReview"), false);
});

test("canSendForReview needs a draft quote on an update form", async () => {
  for (const state of [1, 2]) {
    const page = openQuote({ state });
    lineCount(page, 3);
    await page.fireOnLoad();
    await page.settle();
    assert.equal(rule(page, "canSendForReview"), false, `state ${state}`);
  }
  const create = openQuote({ id: undefined });
  assert.equal(rule(create, "canSendForReview"), false);
});

test("a column missing from the form is unknown, so a fail-closed rule hides the button", async () => {
  const page = openQuote({ attributes: { name: "Northwind renewal" } });
  lineCount(page, 3);
  await page.fireOnLoad();
  await page.settle();
  assert.equal(rule(page, "canSendForReview"), false);
});

test("a count read for another quote isn't used for this one", async () => {
  const page = openQuote();
  lineCount(page, 3);
  await page.fireOnLoad();
  await page.settle();
  assert.equal(rule(page, "canSendForReview"), true);

  // The same script frame now shows a different record.
  const other = createForm({
    entityName: "quote",
    id: fakeGuid(43),
    attributes: { statecode: { type: "optionset", value: 0, options: STATES } },
  });
  assert.equal(page.call("KhQuoteRibbon.canSendForReview", other.formContext), false);
});

// ---- fail-open: canWithdrawReview

test("canWithdrawReview shows for an active quote and hides otherwise", () => {
  assert.equal(rule(openQuote({ state: 1 }), "canWithdrawReview"), true);
  assert.equal(rule(openQuote({ state: 0 }), "canWithdrawReview"), false);
  assert.equal(rule(openQuote({ state: 2 }), "canWithdrawReview"), false);
});

test("canWithdrawReview fails open when the state can't be read", () => {
  const page = openQuote({ attributes: { name: "Northwind renewal" } });
  assert.equal(rule(page, "canWithdrawReview"), true);
});

test("a rule that throws takes its policy's answer, and the throw is logged", () => {
  const closed = openQuote();
  const open = openQuote();
  for (const page of [closed, open]) {
    page.form.formContext.ui.getFormType = () => {
      throw new Error("not ready");
    };
    page.form.formContext.getAttribute = () => {
      throw new Error("not ready");
    };
  }
  assert.equal(rule(closed, "canSendForReview"), false);
  assert.equal(rule(open, "canWithdrawReview"), true);
  assert.equal(open.sandbox.logs.filter((entry) => entry.level === "warn").length, 1);
});

// ---- fail-closed on a missing library: canOverrideDiscount

test("canOverrideDiscount follows the role when the helper library is loaded", () => {
  const roles = [{ id: bracedId(fakeGuid(1)), name: "Sales Manager" }];
  const manager = openQuote({ libraries: [HELPERS, RULES], xrm: { globalContext: { roles } } });
  assert.equal(rule(manager, "canOverrideDiscount"), true);
  const salesperson = openQuote({ libraries: [HELPERS, RULES], xrm: { globalContext: { roles: [{ id: bracedId(fakeGuid(2)), name: "Salesperson" }] } } });
  assert.equal(rule(salesperson, "canOverrideDiscount"), false);
});

test("canOverrideDiscount hides the button when the helper library isn't loaded", () => {
  const roles = [{ id: bracedId(fakeGuid(1)), name: "Sales Manager" }];
  const page = openQuote({ xrm: { globalContext: { roles } } });
  assert.equal(rule(page, "canOverrideDiscount"), false);
});

// ---- the poll

test("the ribbon is refreshed only when the answer changes", async () => {
  const page = openQuote();
  const lines = lineCount(page, 0);

  await page.fireOnLoad();
  await page.settle();
  assert.equal(lines.reads, 1);
  assert.equal(page.form.ribbonRefreshes, 0, "unknown and no lines both hide the button");

  await pollOnce(page);
  await pollOnce(page);
  assert.equal(lines.reads, 3);
  assert.equal(page.form.ribbonRefreshes, 0, "same answer, no refresh");

  lines.count = 2;
  await pollOnce(page);
  assert.equal(page.form.ribbonRefreshes, 1);
  await pollOnce(page);
  assert.equal(page.form.ribbonRefreshes, 1);

  lines.count = 0;
  await pollOnce(page);
  assert.equal(page.form.ribbonRefreshes, 2);
});

test("a failed read keeps the last answer and the poll carries on", async () => {
  const page = openQuote();
  const lines = lineCount(page, 2);
  await page.fireOnLoad();
  await page.settle();
  assert.equal(rule(page, "canSendForReview"), true);

  lines.fail = true;
  await pollOnce(page);
  assert.equal(rule(page, "canSendForReview"), true);
  assert.equal(page.form.ribbonRefreshes, 1);

  lines.fail = false;
  lines.count = 0;
  await pollOnce(page);
  assert.equal(rule(page, "canSendForReview"), false);
  assert.equal(page.form.ribbonRefreshes, 2);
  assert.deepEqual(page.form.scriptErrors, []);
});

test("OnLoad firing again replaces the poll instead of doubling it", async () => {
  const page = openQuote();
  const lines = lineCount(page, 1);
  await page.fireOnLoad();
  await page.settle();
  await page.fireOnLoad();
  await page.settle();
  assert.equal(page.timers.pending, 1);

  const before = lines.reads;
  await pollOnce(page);
  assert.equal(lines.reads, before + 1);
});

test("stopLinePoll stops the timer, and a new record starts none", async () => {
  const page = openQuote();
  const lines = lineCount(page, 1);
  await page.fireOnLoad();
  await page.settle();
  page.call("KhQuoteRibbon.stopLinePoll");
  assert.equal(page.timers.pending, 0);
  await pollOnce(page);
  assert.equal(lines.reads, 1);

  const create = openQuote({ id: undefined });
  const createLines = lineCount(create, 1);
  await create.fireOnLoad();
  await create.settle();
  assert.equal(createLines.reads, 0);
  assert.equal(create.timers.pending, 0);
});

test("the poll gives up after five minutes of reads and keeps the last answer", async () => {
  const page = openQuote();
  const lines = lineCount(page, 1);
  await page.fireOnLoad();
  await page.settle();
  for (let read = 2; read <= 60; read += 1) await pollOnce(page);
  assert.equal(lines.reads, 60);
  assert.equal(page.timers.pending, 0);

  lines.count = 0;
  await pollOnce(page);
  assert.equal(lines.reads, 60);
  assert.equal(rule(page, "canSendForReview"), true, "the last count stands");
});

test("a ribbon that can't be refreshed stops the poll", async () => {
  const page = openQuote();
  const lines = lineCount(page, 1);
  page.form.formContext.ui.refreshRibbon = () => {
    throw new Error("the form has gone");
  };
  await page.fireOnLoad();
  await page.settle();
  assert.equal(lines.reads, 1);
  assert.equal(page.timers.pending, 0);
  assert.equal(page.sandbox.logs.filter((entry) => entry.level === "warn").length, 1);
  assert.deepEqual(page.form.scriptErrors, []);
});

test("a read that finishes after the poll was stopped doesn't schedule another", async () => {
  const page = openQuote();
  const gate = deferred();
  page.xrm.webApi.respond("retrieveMultipleRecords", () => gate.promise);
  await page.fireOnLoad();
  await page.settle();

  page.call("KhQuoteRibbon.stopLinePoll");
  gate.resolve([{ quotedetailid: fakeGuid(1) }]);
  await page.settle();
  assert.equal(page.timers.pending, 0);
});
