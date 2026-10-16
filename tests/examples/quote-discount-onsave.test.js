"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { openForm, fakeGuid, deferred, xrmError, xrmResponse, SAVE_MODE } = require("../../harness");

const LIBRARY = path.join(__dirname, "..", "..", "examples", "quote-discount-onsave", "kh_quotediscount.js");
const QUOTE_ID = fakeGuid(42);
const API = "kh_RecalculateQuoteDiscount";
const MSG_CHECK_FAILED = "The discount couldn't be checked, so the quote wasn't saved.";

async function openQuote(overrides = {}) {
  const quote = openForm({
    libraries: [LIBRARY],
    entityName: "quote",
    id: QUOTE_ID,
    attributes: {
      name: "Northwind renewal",
      discountpercentage: { type: "decimal", value: 5 },
    },
    handlers: { onLoad: ["KhQuoteDiscount.onLoad"] },
    ...overrides,
  });
  await quote.fireOnLoad();
  return quote;
}

const executeCalls = (quote) => quote.xrm.callsTo("WebApi.online.execute");
const confirmCalls = (quote) => quote.xrm.callsTo("Navigation.openConfirmDialog");
const outcomes = (quote) => quote.form.saveAttempts.map((attempt) => [attempt.outcome, attempt.source]);
const allows = (quote, applied, message) =>
  quote.xrm.webApi.respondToExecute(API, () =>
    message === undefined ? { AppliedDiscountPercentage: applied } : { AppliedDiscountPercentage: applied, Message: message },
  );
const noScriptErrors = (quote) => assert.deepEqual(quote.form.scriptErrors, []);

test("editing only the quote name saves at once, without calling the Custom API", async () => {
  const quote = await openQuote();
  quote.form.userEdit("name", "Northwind renewal, year 2");
  await quote.form.userSave();
  await quote.settle();

  assert.deepEqual(executeCalls(quote), []);
  assert.deepEqual(outcomes(quote), [["saved", "user"]]);
  noScriptErrors(quote);
});

test("a new quote saves unchecked, because it has no id to send yet", async () => {
  const quote = await openQuote({ id: undefined });
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.deepEqual(executeCalls(quote), []);
  assert.deepEqual(outcomes(quote), [["saved", "user"]]);
  assert.equal(quote.form.saves[0].values.discountpercentage, 12.5);
  noScriptErrors(quote);
});

test("clearing the discount needs no check", async () => {
  const quote = await openQuote();
  quote.form.userEdit("discountpercentage", null);
  await quote.form.userSave();
  await quote.settle();

  assert.deepEqual(executeCalls(quote), []);
  assert.deepStrictEqual(quote.form.saves[0].values, { discountpercentage: null });
  noScriptErrors(quote);
});

test("neither the user's save nor the fresh save sees a returned promise", async () => {
  const quote = await openQuote();
  allows(quote, 12.5);
  quote.form.userEdit("discountpercentage", 12.5);
  const attempt = await quote.form.userSave();
  await quote.settle();

  assert.equal(attempt.returnedPromise, false);
  assert.equal(quote.form.saveAttempts[1].returnedPromise, false, "the follow-up save too");
  noScriptErrors(quote);
});

test("a changed discount cancels the user's save and leaves one zero-delay timer", async () => {
  const quote = await openQuote();
  allows(quote, 12.5);
  quote.form.userEdit("discountpercentage", 12.5);
  const attempt = await quote.form.userSave();

  assert.equal(attempt.outcome, "prevented");
  assert.deepEqual(executeCalls(quote), [], "the Custom API isn't called before the handler returns");
  assert.equal(quote.timers.pending, 1);
  assert.deepEqual(quote.form.saves, []);
  noScriptErrors(quote);
});

test("the check calls kh_RecalculateQuoteDiscount once with the quote id and the requested discount", async () => {
  const quote = await openQuote();
  allows(quote, 12.5);
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.deepStrictEqual(executeCalls(quote), [
    {
      api: "WebApi.online.execute",
      operationName: API,
      operationType: 0,
      boundParameter: null,
      parameters: { QuoteId: { guid: QUOTE_ID }, DiscountPercentage: 12.5 },
    },
  ]);
  noScriptErrors(quote);
});

test("an allowed discount is saved by one fresh save", async () => {
  const quote = await openQuote();
  allows(quote, 12.5);
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.deepStrictEqual(quote.form.saves, [{ saveMode: 1, source: "script", values: { discountpercentage: 12.5 } }]);
  assert.deepEqual(outcomes(quote), [
    ["prevented", "user"],
    ["saved", "script"],
  ]);
  assert.equal(quote.form.formContext.data.getIsDirty(), false);
  assert.deepEqual(confirmCalls(quote), []);
  assert.deepEqual(quote.form.formNotifications, {});
  noScriptErrors(quote);
});

test("the progress indicator wraps the check and is closed before anything else", async () => {
  const quote = await openQuote();
  allows(quote, 12.5);
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.deepEqual(quote.xrm.calls.map((call) => call.api), [
    "Utility.showProgressIndicator",
    "WebApi.online.execute",
    "Utility.closeProgressIndicator",
  ]);
  assert.equal(quote.xrm.calls[0].message, "Checking the discount...");
  assert.equal(quote.xrm.utility.progressVisible, false);
  noScriptErrors(quote);
});

test("a reduced discount asks first and saves the allowed value when confirmed", async () => {
  const quote = await openQuote();
  allows(quote, 10, "Renewals are capped at 10% this quarter.");
  quote.xrm.navigation.answerConfirm(true);
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.deepStrictEqual(confirmCalls(quote)[0].confirmStrings, {
    title: "Discount limit",
    text: "Renewals are capped at 10% this quarter.",
    confirmButtonLabel: "Save with 10%",
    cancelButtonLabel: "Keep editing",
  });
  assert.deepEqual(quote.xrm.calls.map((call) => call.api), [
    "Utility.showProgressIndicator",
    "WebApi.online.execute",
    "Utility.closeProgressIndicator",
    "Navigation.openConfirmDialog",
  ]);
  assert.deepStrictEqual(quote.form.saves, [{ saveMode: 1, source: "script", values: { discountpercentage: 10 } }]);
  assert.equal(quote.form.value("discountpercentage"), 10);
  assert.equal(executeCalls(quote).length, 1);
  noScriptErrors(quote);
});

test("the default confirm text is used when the server sends no message", async () => {
  const quote = await openQuote();
  allows(quote, 10);
  quote.xrm.navigation.answerConfirm(true);
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.equal(confirmCalls(quote)[0].confirmStrings.text, "The discount policy allows 10% on this quote.");
  assert.equal(quote.form.saves.length, 1);
  noScriptErrors(quote);
});

test("declining keeps the user's value and saves nothing", async () => {
  const quote = await openQuote();
  allows(quote, 10);
  quote.xrm.navigation.answerConfirm(false);
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.equal(quote.form.value("discountpercentage"), 12.5);
  assert.equal(quote.form.attribute("discountpercentage").getIsDirty(), true);
  assert.deepEqual(quote.form.saves, []);
  assert.deepEqual(quote.form.formNotifications, {});
  assert.equal(quote.timers.pending, 0);
  noScriptErrors(quote);
});

test("a second save while the check is in flight is cancelled without a second call", async () => {
  const quote = await openQuote();
  const answer = deferred();
  quote.xrm.webApi.respondToExecute(API, () => answer.promise);
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();
  assert.equal(executeCalls(quote).length, 1);

  const second = await quote.form.userSave();
  assert.equal(second.outcome, "prevented");
  assert.equal(quote.timers.pending, 0, "the second save starts nothing");

  answer.resolve({ AppliedDiscountPercentage: 12.5 });
  await quote.settle();
  assert.equal(executeCalls(quote).length, 1);
  assert.equal(quote.form.saves.length, 1);
  assert.deepEqual(outcomes(quote), [
    ["prevented", "user"],
    ["prevented", "user"],
    ["saved", "script"],
  ]);
  noScriptErrors(quote);
});

test("a failed check shows a notification and doesn't loop", async () => {
  const quote = await openQuote();
  quote.xrm.webApi.respondToExecute(API, () => {
    throw xrmError("Custom API is not registered.");
  });
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.deepEqual(quote.form.formNotifications, {
    kh_quotediscount: { message: MSG_CHECK_FAILED + " Custom API is not registered.", level: "ERROR" },
  });
  assert.deepEqual(quote.form.saves, []);
  assert.equal(executeCalls(quote).length, 1);
  assert.equal(quote.timers.pending, 0);
  assert.equal(quote.xrm.utility.progressVisible, false);

  const callsBefore = quote.xrm.calls.length;
  await quote.settle();
  assert.equal(quote.xrm.calls.length, callsBefore, "no retry is scheduled");
  noScriptErrors(quote);
});

test("a non-ok response counts as a failed check", async () => {
  const quote = await openQuote();
  quote.xrm.webApi.respondToExecute(API, () => xrmResponse({}, { status: 500, statusText: "Server Error" }));
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.equal(quote.form.formNotifications.kh_quotediscount.message, MSG_CHECK_FAILED + " HTTP 500 Server Error");
  assert.deepEqual(quote.form.saves, []);
  noScriptErrors(quote);
});

test("a response without AppliedDiscountPercentage counts as a failed check", async () => {
  const quote = await openQuote();
  quote.xrm.webApi.respondToExecute(API, () => ({ Message: "No number here." }));
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.equal(
    quote.form.formNotifications.kh_quotediscount.message,
    MSG_CHECK_FAILED + " The response had no AppliedDiscountPercentage.",
  );
  assert.deepEqual(quote.form.saves, []);
  noScriptErrors(quote);
});

test("the user can try again after a failure", async () => {
  const quote = await openQuote();
  quote.xrm.webApi.respondToExecute(API, () => {
    throw xrmError("Service unavailable.");
  });
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();
  assert.equal(quote.form.saves.length, 0);

  allows(quote, 12.5);
  await quote.form.userSave();
  await quote.settle();
  assert.equal(executeCalls(quote).length, 2);
  assert.equal(quote.form.saves.length, 1);
  assert.deepEqual(quote.form.formNotifications, {}, "the old notification is cleared when the check starts again");
  noScriptErrors(quote);
});

test("when the fresh save fails, its error is shown and the approved value saves next time without another call", async () => {
  const quote = await openQuote();
  allows(quote, 12.5);
  quote.form.failNextSave(xrmError("A required column is empty."));
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.deepEqual(quote.form.formNotifications, {
    kh_quotediscount: { message: "The quote wasn't saved: A required column is empty.", level: "ERROR" },
  });
  assert.deepEqual(quote.form.saves, []);

  const attempt = await quote.form.userSave();
  assert.equal(attempt.outcome, "saved");
  assert.equal(executeCalls(quote).length, 1, "the approved value goes through without a second check");
  assert.equal(quote.form.saves.length, 1);
  assert.deepEqual(quote.form.formNotifications, {}, "the old error is gone once the quote has saved");
  noScriptErrors(quote);
});

test("putting the discount back after a failed check clears the message when the save goes through", async () => {
  const quote = await openQuote();
  quote.xrm.webApi.respondToExecute(API, () => {
    throw xrmError("Service unavailable.");
  });
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();
  assert.equal(quote.form.formNotifications.kh_quotediscount.message, MSG_CHECK_FAILED + " Service unavailable.");

  quote.form.userEdit("discountpercentage", 5);
  quote.form.userEdit("name", "Northwind renewal, year 2");
  const attempt = await quote.form.userSave();
  assert.equal(attempt.outcome, "saved");
  assert.deepEqual(quote.form.formNotifications, {});
  assert.equal(executeCalls(quote).length, 1);
  noScriptErrors(quote);
});

test("a confirm dialog that fails is reported like a failed check", async () => {
  const quote = await openQuote();
  allows(quote, 10); // no answer queued, so the fake confirm dialog rejects
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  assert.deepEqual(quote.form.formNotifications, {
    kh_quotediscount: {
      message: MSG_CHECK_FAILED + " FormScriptKit: openConfirmDialog was called but the test queued no answer",
      level: "ERROR",
    },
  });
  assert.deepEqual(quote.form.saves, []);
  assert.equal(quote.form.value("discountpercentage"), 12.5);
  assert.equal(quote.timers.pending, 0);

  quote.xrm.navigation.answerConfirm(true);
  await quote.form.userSave();
  await quote.settle();
  assert.deepStrictEqual(quote.form.saves, [{ saveMode: 1, source: "script", values: { discountpercentage: 10 } }]);
  noScriptErrors(quote);
});

test("Save & Close is checked too, and finishes as a plain save that leaves the form open", async () => {
  const quote = await openQuote();
  allows(quote, 12.5);
  quote.form.userEdit("discountpercentage", 12.5);
  const attempt = await quote.form.userSave(SAVE_MODE.SAVE_AND_CLOSE);
  await quote.settle();

  assert.equal(attempt.outcome, "prevented");
  assert.equal(executeCalls(quote).length, 1);
  assert.deepStrictEqual(quote.form.saves, [{ saveMode: SAVE_MODE.SAVE, source: "script", values: { discountpercentage: 12.5 } }]);
  noScriptErrors(quote);
});

test("a quote created on the form and then edited is checked once per save", async () => {
  const scenarios = [
    { allowed: 12.5, confirms: [] },
    { allowed: 10, confirms: [true] },
  ];
  for (const { allowed, confirms } of scenarios) {
    const quote = await openQuote({ id: undefined });
    allows(quote, allowed);
    quote.xrm.navigation.answerConfirm(...confirms);

    quote.form.userEdit("name", "Northwind renewal, draft");
    await quote.form.userSave(); // creates the quote; the form fires OnLoad again
    assert.deepEqual(quote.loads, [{ loadState: 1 }, { loadState: 2 }]);

    quote.form.userEdit("discountpercentage", 12.5);
    await quote.form.userSave();
    await quote.settle();

    const label = `allowed ${allowed}`;
    assert.equal(executeCalls(quote).length, 1, label);
    assert.deepEqual(executeCalls(quote)[0].parameters.QuoteId, { guid: fakeGuid(1001) }, label);
    assert.equal(confirmCalls(quote).length, confirms.length, label);
    assert.deepEqual(
      outcomes(quote),
      [
        ["saved", "user"],
        ["prevented", "user"],
        ["saved", "script"],
      ],
      label,
    );
    assert.deepStrictEqual(quote.form.saves[1], {
      saveMode: 1,
      source: "script",
      values: { discountpercentage: allowed },
    });
    assert.equal(quote.form.formContext.data.getIsDirty(), false, label);
    assert.deepEqual(quote.form.formNotifications, {}, label);
    noScriptErrors(quote);
  }
});

test("another library's promise-returning OnSave handler makes the fresh save fail; the next save goes through", async () => {
  const gate = deferred();
  const quote = await openQuote({
    globals: { KhOtherLibrary: { onSave: () => gate.promise } },
    handlers: { onSave: ["KhOtherLibrary.onSave"], onLoad: ["KhQuoteDiscount.onLoad"] },
  });
  allows(quote, 12.5);
  quote.form.userEdit("discountpercentage", 12.5);

  const cancelled = quote.form.userSave(); // held open by the other handler's promise
  await quote.settle();
  assert.deepEqual(quote.form.formNotifications, {
    kh_quotediscount: { message: "The quote wasn't saved: Please wait while saving is completed", level: "ERROR" },
  });
  assert.deepEqual(quote.form.saves, []);

  gate.resolve();
  assert.equal((await cancelled).outcome, "prevented");
  const retry = await quote.form.userSave();
  assert.equal(retry.outcome, "saved");
  assert.equal(executeCalls(quote).length, 1, "the value was approved, so there is no second check");
  assert.deepEqual(quote.form.formNotifications, {});
  assert.deepEqual(outcomes(quote), [
    ["prevented", "user"],
    ["busy", "script"],
    ["saved", "user"],
  ]);
  noScriptErrors(quote);
});

test("an autosave with an unchecked discount is cancelled without a check", async () => {
  const quote = await openQuote();
  allows(quote, 12.5);
  quote.form.userEdit("discountpercentage", 12.5);
  const attempt = await quote.form.userSave(SAVE_MODE.AUTOSAVE);
  await quote.settle();

  assert.equal(attempt.outcome, "prevented");
  assert.equal(quote.timers.pending, 0);
  assert.deepEqual(executeCalls(quote), []);
  noScriptErrors(quote);
});

test("an edit made while the check is in flight wins", async () => {
  const quote = await openQuote();
  const answer = deferred();
  quote.xrm.webApi.respondToExecute(API, () => answer.promise);
  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave();
  await quote.settle();

  quote.form.userEdit("discountpercentage", 20);
  answer.resolve({ AppliedDiscountPercentage: 12.5 });
  await quote.settle();
  assert.deepEqual(confirmCalls(quote), []);
  assert.deepEqual(quote.form.saves, []);
  assert.deepEqual(quote.form.formNotifications, {});
  assert.equal(quote.form.value("discountpercentage"), 20);

  allows(quote, 20);
  await quote.form.userSave();
  await quote.settle();
  assert.equal(executeCalls(quote)[1].parameters.DiscountPercentage, 20);
  assert.deepStrictEqual(quote.form.saves, [{ saveMode: 1, source: "script", values: { discountpercentage: 20 } }]);
  noScriptErrors(quote);
});
