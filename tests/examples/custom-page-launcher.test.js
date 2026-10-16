"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { openForm, createStorage, fakeGuid, xrmError, toHost } = require("../../harness");

const LIBRARY = path.join(__dirname, "..", "..", "examples", "custom-page-launcher", "kh_pagelauncher.js");
const QUOTE_ID = fakeGuid(42);
const BARE_ID = QUOTE_ID.toLowerCase();
const RESULT_KEY = "kh_pagelauncher_result_" + BARE_ID;
const HOUR = 60 * 60 * 1000;

function openQuote({ viewport = 1000, localStorage = createStorage(), ...overrides } = {}) {
  const page = openForm({
    libraries: [LIBRARY],
    entityName: "quote",
    id: QUOTE_ID,
    attributes: { name: "Northwind renewal" },
    localStorage,
    globals: viewport === null ? {} : { innerHeight: viewport },
    ...overrides,
  });
  const open = () => page.call("KhPageLauncher.openLineEditor", page.form.formContext);
  return { page, localStorage, open };
}

const withLines = (page, count) =>
  page.xrm.webApi.respond("retrieveMultipleRecords", () => Array.from({ length: count }, (_, i) => ({ quotedetailid: fakeGuid(i + 1) })));
const dialogCalls = (page) => page.xrm.callsTo("Navigation.navigateTo");
const heightOf = (page) => dialogCalls(page)[0].navigationOptions.height;

// ---- sizing

test("dialogHeight is what the lines need, between the shortest height and 80% of the window", () => {
  const { page } = openQuote();
  const height = (...args) => page.call("KhPageLauncher.dialogHeight", ...args);
  assert.equal(height(0, 1000), 380);
  assert.equal(height(5, 1000), 250 + 5 * 40);
  assert.equal(height(50, 1000), 800);
  assert.equal(height(50, 400), 320, "a short window wins over the shortest height");
  assert.equal(height(50, undefined), 640, "an 800-pixel window is assumed when there's no number");
});

test("the dialog height is computed before opening, from the line count and the viewport", async () => {
  const { page, open } = openQuote({ viewport: 1000 });
  withLines(page, 5);
  page.xrm.navigation.respondToNavigateTo(() => undefined);
  await open();

  const [call] = dialogCalls(page);
  assert.deepStrictEqual(call.pageInput, {
    pageType: "custom",
    name: "kh_quotelineeditor_1a2b3",
    entityName: "quote",
    recordId: BARE_ID,
  });
  assert.deepStrictEqual(call.navigationOptions, {
    target: 2,
    position: 1,
    width: { value: 50, unit: "%" },
    height: { value: 450, unit: "px" },
    title: "Edit lines",
  });
  const [query] = page.xrm.callsTo("WebApi.retrieveMultipleRecords");
  assert.equal(query.entityName, "quotedetail");
  assert.match(query.options, new RegExp(`_quoteid_value eq ${BARE_ID}`));
  assert.match(query.options, /&\$top=14$/, "no more lines than could change the height");
});

test("a long quote is capped by the window, and the count stops where the cap starts", async () => {
  const { page, open } = openQuote({ viewport: 700 });
  withLines(page, 8);
  page.xrm.navigation.respondToNavigateTo(() => undefined);
  await open();
  assert.deepStrictEqual(heightOf(page), { value: 560, unit: "px" });
  assert.match(page.xrm.callsTo("WebApi.retrieveMultipleRecords")[0].options, /&\$top=8$/);
});

test("when the count can't be read, a fixed height is used and the dialog still opens", async () => {
  const { page, open } = openQuote();
  page.xrm.webApi.respond("retrieveMultipleRecords", () => {
    throw xrmError("Service unavailable.");
  });
  page.xrm.navigation.respondToNavigateTo(() => undefined);
  await open();
  assert.deepStrictEqual(heightOf(page), { value: 540, unit: "px" });
});

// ---- the hand-back

test("a saved result refreshes the form, shows the page's message and is removed from storage", async () => {
  const { page, localStorage, open } = openQuote();
  withLines(page, 2);
  page.xrm.navigation.respondToNavigateTo(() => {
    localStorage.setItem(RESULT_KEY, JSON.stringify({ at: Date.now(), saved: true, message: "2 lines updated." }));
  });

  const result = await open();

  assert.deepEqual(toHost(result).saved, true);
  assert.equal(page.form.refreshes.length, 1);
  assert.deepEqual(page.form.formNotifications, { kh_pagelauncher: { message: "2 lines updated.", level: "INFO" } });
  assert.equal(localStorage.getItem(RESULT_KEY), null);
});

test("a dialog closed without saving leaves the form alone", async () => {
  const { page, localStorage, open } = openQuote();
  withLines(page, 2);
  page.xrm.navigation.respondToNavigateTo(() => {
    localStorage.setItem(RESULT_KEY, JSON.stringify({ at: Date.now(), saved: false }));
  });
  await open();
  assert.equal(page.form.refreshes.length, 0);
  assert.deepEqual(page.form.formNotifications, {});
  assert.equal(localStorage.getItem(RESULT_KEY), null);
});

test("no entry at all, or an unreadable one, is treated as nothing saved", async () => {
  const { page, localStorage, open } = openQuote();
  withLines(page, 1);
  page.xrm.navigation.respondToNavigateTo(() => undefined);
  assert.equal(await open(), null);

  page.xrm.navigation.respondToNavigateTo(() => localStorage.setItem(RESULT_KEY, "{not json"));
  assert.equal(await open(), null);
  assert.equal(localStorage.getItem(RESULT_KEY), null);
  assert.equal(page.form.refreshes.length, 0);
});

test("an entry left by an earlier open is not mistaken for this one's result", async () => {
  const { page, localStorage, open } = openQuote();
  withLines(page, 1);
  localStorage.setItem(RESULT_KEY, JSON.stringify({ at: Date.now(), saved: true }));
  page.xrm.navigation.respondToNavigateTo(() => undefined);
  await open();
  assert.equal(page.form.refreshes.length, 0);
});

test("blocked storage doesn't stop the dialog from opening", async () => {
  const { page, localStorage, open } = openQuote();
  withLines(page, 1);
  localStorage.blocked = true;
  page.xrm.navigation.respondToNavigateTo(() => undefined);
  assert.equal(await open(), null);
  assert.equal(dialogCalls(page).length, 1);
  assert.deepEqual(page.form.scriptErrors, []);
});

// ---- cleanup

test("each launch removes its own expired or unreadable keys and nobody else's", async () => {
  const { page, localStorage, open } = openQuote();
  withLines(page, 1);
  const now = Date.now();
  const mine = "kh_pagelauncher_result_";
  localStorage.setItem(mine + "old", JSON.stringify({ at: now - HOUR - 1000, saved: true }));
  localStorage.setItem(mine + "fresh", JSON.stringify({ at: now - 1000, saved: true }));
  localStorage.setItem(mine + "garbage", "???");
  localStorage.setItem(mine + "undated", JSON.stringify({ saved: true }));
  localStorage.setItem("other_old", JSON.stringify({ at: now - 10 * HOUR }));
  page.xrm.navigation.respondToNavigateTo(() => undefined);

  await open();

  assert.deepEqual(Object.keys(localStorage.snapshot()).sort(), [mine + "fresh", "other_old"]);
});

// ---- guard rails

test("a new quote, or one with unsaved changes, asks for a save and opens nothing", async () => {
  const fresh = openQuote({ id: undefined });
  const edited = openQuote();
  edited.page.form.userEdit("name", "Northwind renewal, revised");
  for (const { page, open } of [fresh, edited]) {
    assert.equal(await open(), null);
    assert.deepEqual(page.xrm.callsTo("Navigation.openAlertDialog").map((call) => call.alertStrings.text), [
      "Save the quote before editing its lines.",
    ]);
    assert.deepEqual(dialogCalls(page), []);
  }
});

test("a dialog that can't be opened is reported on the form", async () => {
  const { page, open } = openQuote();
  withLines(page, 1);
  page.xrm.navigation.respondToNavigateTo(() => {
    throw xrmError("No such page.");
  });
  assert.equal(await open(), null);
  assert.deepEqual(page.form.formNotifications, {
    kh_pagelauncher: { message: "The line editor couldn't be opened: No such page.", level: "ERROR" },
  });
});
