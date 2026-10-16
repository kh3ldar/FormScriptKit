"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { openForm, toHost, fakeGuid, xrmError, xrmResponse, bracedId } = require("../../harness");

const LIBRARY = path.join(__dirname, "..", "..", "examples", "form-helpers", "kh_formhelpers.js");
const QUOTE_ID = fakeGuid(42);

function openQuote(overrides = {}) {
  return openForm({
    libraries: [LIBRARY],
    entityName: "quote",
    id: QUOTE_ID,
    attributes: { name: "Northwind renewal", description: "", totalamount: { type: "decimal", value: 10 } },
    ...overrides,
  });
}

const helper = (page, name, ...args) => page.call(`KhFormHelpers.${name}`, ...args);
const notices = (page) => Object.entries(page.form.formNotifications).map(([id, n]) => [id, n.level]);
const noScriptErrors = (page) => assert.deepEqual(page.form.scriptErrors, []);

// ---- error-safe wiring

test("a handler that throws shows a form notification and the others still run", () => {
  const page = openQuote();
  const ran = [];
  helper(page, "wireOnChange", page.form.formContext, {
    name: () => {
      throw new Error("boom");
    },
  });
  page.form.attribute("name").addOnChange(() => ran.push("later handler"));

  page.form.userEdit("name", "Renamed");

  assert.deepEqual(ran, ["later handler"]);
  assert.deepEqual(notices(page), [["kh_handler_error_name", "ERROR"]]);
  assert.match(page.form.formNotifications.kh_handler_error_name.message, /^Something went wrong in name: boom$/);
  assert.equal(page.sandbox.logs.filter((entry) => entry.level === "error").length, 1);
  noScriptErrors(page);
});

test("without the wrapper the same throw lands in the form's script errors", () => {
  const page = openQuote();
  page.form.attribute("name").addOnChange(() => {
    throw new Error("boom");
  });
  page.form.userEdit("name", "Renamed");
  assert.equal(page.form.scriptErrors.length, 1);
  assert.deepEqual(notices(page), []);
});

test("a rejected promise is reported too, and a later success clears the notification", async () => {
  const page = openQuote();
  let fail = true;
  helper(page, "wireOnChange", page.form.formContext, {
    description: async () => {
      await null;
      if (fail) throw new Error("late failure");
    },
  });

  page.form.userEdit("description", "a");
  await page.settle();
  assert.deepEqual(notices(page), [["kh_handler_error_description", "ERROR"]]);

  fail = false;
  page.form.userEdit("description", "b");
  await page.settle();
  assert.deepEqual(notices(page), []);
  noScriptErrors(page);
});

test("an attribute that isn't on the form is skipped with a warning, and unwire removes the handlers", () => {
  const page = openQuote();
  const seen = [];
  const wiring = helper(page, "wireOnChange", page.form.formContext, {
    name: () => seen.push("name"),
    missing_column: () => seen.push("missing"),
  });
  assert.equal(page.sandbox.logs.filter((entry) => entry.level === "warn").length, 1);

  page.form.userEdit("name", "One");
  wiring.unwire();
  page.form.userEdit("name", "Two");
  assert.deepEqual(seen, ["name"]);
});

// ---- progress

test("withProgress closes the indicator on success and returns the result", async () => {
  const page = openQuote();
  const result = await helper(page, "withProgress", "Working", async () => {
    assert.equal(page.xrm.utility.progressVisible, true);
    return 7;
  });
  assert.equal(result, 7);
  assert.equal(page.xrm.utility.progressVisible, false);
  assert.deepEqual(page.xrm.calls.map((call) => call.api), [
    "Utility.showProgressIndicator",
    "Utility.closeProgressIndicator",
  ]);
});

test("withProgress closes the indicator when the work throws, and rethrows", async () => {
  const page = openQuote();
  await assert.rejects(
    helper(page, "withProgress", "Working", () => Promise.reject(new Error("nope"))),
    /nope/,
  );
  assert.equal(page.xrm.utility.progressVisible, false);
});

// ---- confirm, then progress

// A requestAnimationFrame the test steps by hand.
function frames() {
  const queue = [];
  return { requestAnimationFrame: (callback) => queue.push(callback), run: () => queue.splice(0).forEach((cb) => cb()) };
}

test("progress waits for two frames and the settle floor after the confirm resolves", async () => {
  const raf = frames();
  const page = openQuote({ globals: { requestAnimationFrame: raf.requestAnimationFrame } });
  page.xrm.navigation.answerConfirm(true);
  const worked = [];
  const done = helper(page, "confirmThenProgress", { text: "Send it?" }, "Sending", async () => worked.push("work"));
  const shown = () => page.xrm.callsTo("Utility.showProgressIndicator").length;

  await page.settle();
  assert.equal(page.xrm.callsTo("Navigation.openConfirmDialog").length, 1);
  assert.equal(shown(), 0, "no frame has been painted yet");

  raf.run();
  await page.settle();
  assert.equal(shown(), 0, "one frame is not enough");

  raf.run();
  await page.settle();
  assert.equal(shown(), 0, "the floor hasn't passed");

  page.timers.advance(149);
  await page.settle();
  assert.equal(shown(), 0);

  page.timers.advance(1);
  assert.deepEqual(toHost(await done), { confirmed: true, result: 1 });
  assert.equal(shown(), 1);
  assert.deepEqual(worked, ["work"]);
  assert.equal(page.xrm.utility.progressVisible, false);
});

test("without requestAnimationFrame only the floor applies", async () => {
  const page = openQuote();
  page.xrm.navigation.answerConfirm(true);
  const done = helper(page, "confirmThenProgress", { text: "Send it?" }, "Sending", async () => "x");
  await page.settle();
  assert.equal(page.xrm.callsTo("Utility.showProgressIndicator").length, 0);
  page.timers.advance(150);
  assert.deepEqual(toHost(await done), { confirmed: true, result: "x" });
});

test("declining runs nothing and shows no progress", async () => {
  const page = openQuote();
  page.xrm.navigation.answerConfirm(false);
  const done = helper(page, "confirmThenProgress", { text: "Send it?" }, "Sending", () => assert.fail("not wanted"));
  await page.settle();
  page.timers.advance(150);
  assert.deepEqual(toHost(await done), { confirmed: false });
  assert.deepEqual(page.xrm.callsTo("Utility.showProgressIndicator"), []);
});

// ---- roles

test("hasAnyRole matches case-insensitively and reads the roles once", () => {
  const page = openQuote({
    xrm: { globalContext: { roles: [{ id: bracedId(fakeGuid(1)), name: "Sales Manager" }, { id: bracedId(fakeGuid(2)), name: "Sales Manager" }] } },
  });
  const { Xrm } = page.sandbox.global;
  const real = Xrm.Utility.getGlobalContext;
  let reads = 0;
  Xrm.Utility.getGlobalContext = () => {
    reads += 1;
    return real();
  };

  assert.equal(helper(page, "hasAnyRole", ["system administrator", "SALES MANAGER"]), true);
  assert.equal(helper(page, "hasAnyRole", ["salesperson"]), false);
  assert.equal(helper(page, "hasAnyRole", ["sales manager"]), true);
  assert.equal(reads, 1);
});

test("a failed role read answers false and isn't cached", () => {
  const page = openQuote({ xrm: { globalContext: { roles: [{ id: bracedId(fakeGuid(1)), name: "Sales Manager" }] } } });
  const { Xrm } = page.sandbox.global;
  const real = Xrm.Utility.getGlobalContext;
  Xrm.Utility.getGlobalContext = () => {
    throw new Error("not ready");
  };
  assert.equal(helper(page, "hasAnyRole", ["sales manager"]), false);

  Xrm.Utility.getGlobalContext = real;
  assert.equal(helper(page, "hasAnyRole", ["sales manager"]), true);
});

// ---- ribbon action runner

const API = "kh_SendQuoteForReview";

function runAction(page, overrides = {}) {
  return helper(page, "runRibbonAction", {
    formContext: page.form.formContext,
    operationName: API,
    parameters: (formContext) => ({
      QuoteId: { type: "Edm.Guid", value: formContext.data.entity.getId().replace(/[{}]/g, "").toLowerCase() },
    }),
    progressMessage: "Sending for review",
    successMessage: "Sent for review.",
    ...overrides,
  });
}

const notifications = (page) =>
  page.xrm.callsTo("App.addGlobalNotification").map((call) => [call.notification.level, call.notification.message]);

test("a clean form: progress, the Custom API, a message, then refresh and ribbon refresh", async () => {
  const page = openQuote();
  page.xrm.webApi.respondToExecute(API, () => undefined);

  const outcome = await runAction(page);

  assert.equal(outcome.ok, true);
  assert.deepEqual(page.form.saves, []);
  const [call] = page.xrm.callsTo("WebApi.online.execute");
  assert.equal(call.operationName, API);
  assert.deepEqual(call.parameters, { QuoteId: { guid: QUOTE_ID.toLowerCase() } });
  assert.deepEqual(notifications(page), [[1, "Sent for review."]]);
  assert.equal(page.form.refreshes.length, 1);
  assert.equal(page.form.ribbonRefreshes, 1);
  assert.equal(page.xrm.utility.progressVisible, false);
  noScriptErrors(page);
});

test("a dirty form is saved before the Custom API is called", async () => {
  const page = openQuote();
  page.xrm.webApi.respondToExecute(API, () => undefined);
  page.form.userEdit("name", "Renamed");

  await runAction(page);

  assert.equal(page.form.saves.length, 1);
  assert.deepEqual(page.xrm.calls.map((call) => call.api).filter((api) => api.startsWith("WebApi") || api.startsWith("Utility")), [
    "Utility.showProgressIndicator",
    "WebApi.online.execute",
    "Utility.closeProgressIndicator",
  ]);
});

test("a failed save stops before any progress or API call", async () => {
  const page = openQuote();
  page.form.userEdit("name", "Renamed");
  page.form.failNextSave(xrmError("The name is required."));

  const outcome = await runAction(page);

  assert.deepEqual(toHost(outcome), { ok: false, stage: "save" });
  assert.deepEqual(page.xrm.callsTo("WebApi.online.execute"), []);
  assert.deepEqual(page.xrm.callsTo("Utility.showProgressIndicator"), []);
  assert.deepEqual(notifications(page), [[2, "The record couldn't be saved, so the action wasn't run."]]);
});

test("a refusal shows the server's own sentence and still closes the progress indicator", async () => {
  const page = openQuote();
  page.xrm.webApi.respondToExecute(API, () =>
    xrmResponse({ error: { message: "Add at least one line before sending." } }, { status: 400 }),
  );

  const outcome = await runAction(page);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.stage, "action");
  assert.deepEqual(notifications(page), [[2, "Add at least one line before sending."]]);
  assert.equal(page.xrm.utility.progressVisible, false);
  assert.equal(page.form.refreshes.length, 0);
  assert.equal(page.form.ribbonRefreshes, 0);
});

test("a notification that can't be shown doesn't turn success into a failure", async () => {
  const page = openQuote();
  page.xrm.webApi.respondToExecute(API, () => undefined);
  page.sandbox.global.Xrm.App.addGlobalNotification = () => {
    throw new Error("no message bar here");
  };
  const outcome = await runAction(page);
  assert.equal(outcome.ok, true);
  assert.equal(page.form.refreshes.length, 1);
  assert.equal(page.sandbox.logs.filter((entry) => entry.level === "warn").length, 1);
});

test("a rejected call is reported the same way", async () => {
  const page = openQuote();
  page.xrm.webApi.respondToExecute(API, () => {
    throw xrmError("The service is unavailable.");
  });
  const outcome = await runAction(page);
  assert.equal(outcome.ok, false);
  assert.deepEqual(notifications(page), [[2, "The service is unavailable."]]);
  assert.equal(page.xrm.utility.progressVisible, false);
});
