"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openForm, openHtmlWebResource, createStorage, fakeGuid, xrmError } = require("../../harness");

const EXAMPLE_DIR = path.join(__dirname, "..", "..", "examples", "quick-note-dialog");
const OPENER = path.join(EXAMPLE_DIR, "kh_quicknote.js");
const RECORD_ID = fakeGuid(7);
const NOTE_ID = fakeGuid(500);
const BIND_KEY = "objectid_opportunity" + "@odata.bind";

function openOpportunity(overrides = {}) {
  const sessionStorage = createStorage();
  const page = openForm({
    libraries: [OPENER],
    entityName: "opportunity",
    id: RECORD_ID,
    attributes: { name: "Northwind renewal" },
    sessionStorage,
    ...overrides,
  });
  const open = (...args) => page.call("KhQuickNote.open", page.form.formContext, ...args);
  return { page, sessionStorage, open };
}

// A navigateTo responder that plays the dialog: it writes `result` where the
// page would, then resolves, as the platform does when the dialog closes.
function dialogReturns(page, sessionStorage, result) {
  page.xrm.navigation.respondToNavigateTo((pageInput) => {
    const { resultKey } = JSON.parse(pageInput.data);
    if (result !== undefined) sessionStorage.setItem(resultKey, typeof result === "string" ? result : JSON.stringify(result));
    return undefined;
  });
}

const navigateCalls = (page) => page.xrm.callsTo("Navigation.navigateTo");
const createCalls = (page) => page.xrm.callsTo("WebApi.createRecord");
const noScriptErrors = (page) => assert.deepEqual(page.form.scriptErrors, []);

test("on an unsaved record it asks for a save and opens nothing", async () => {
  const { page, open } = openOpportunity({ id: undefined });
  assert.equal(await open("opportunities"), null);
  assert.deepEqual(page.xrm.callsTo("Navigation.openAlertDialog").map((call) => call.alertStrings), [
    { text: "Save the record before adding a note." },
  ]);
  assert.deepEqual(navigateCalls(page), []);
  assert.deepEqual(createCalls(page), []);
  noScriptErrors(page);
});

test("without an entity set name it alerts and opens nothing", async () => {
  const { page, open } = openOpportunity();
  assert.equal(await open(), null);
  assert.equal(await open(""), null);
  const texts = page.xrm.callsTo("Navigation.openAlertDialog").map((call) => call.alertStrings.text);
  assert.deepEqual(texts, [
    "This command needs the table's entity set name as its second parameter.",
    "This command needs the table's entity set name as its second parameter.",
  ]);
  assert.deepEqual(navigateCalls(page), []);
  noScriptErrors(page);
});

test("it opens the dialog web resource with string data and dialog options", async () => {
  const { page, sessionStorage, open } = openOpportunity();
  dialogReturns(page, sessionStorage, undefined);
  assert.equal(await open("opportunities"), null);

  const [call] = navigateCalls(page);
  assert.equal(call.pageInput.pageType, "webresource");
  assert.equal(call.pageInput.webresourceName, "kh_quicknotedialog.html");
  assert.equal(typeof call.pageInput.data, "string");
  assert.deepEqual(Object.keys(call.pageInput).sort(), ["data", "pageType", "webresourceName"]);
  assert.deepStrictEqual(call.navigationOptions, {
    target: 2,
    position: 1,
    width: { value: 480, unit: "px" },
    height: { value: 380, unit: "px" },
    title: "Quick note",
  });
  const data = JSON.parse(call.pageInput.data);
  assert.deepEqual(Object.keys(data).sort(), ["recordName", "resultKey"]);
  assert.match(data.resultKey, /^kh_quicknote_\d+-[0-9a-f]+$/);
  assert.equal(data.recordName, "Northwind renewal");
  noScriptErrors(page);
});

test("angle brackets are stripped from the record name", async () => {
  const { page, sessionStorage, open } = openOpportunity({ attributes: { name: "Northwind <renewal>" } });
  dialogReturns(page, sessionStorage, undefined);
  await open("opportunities");
  assert.equal(JSON.parse(navigateCalls(page)[0].pageInput.data).recordName, "Northwind renewal");
  noScriptErrors(page);
});

test("each open uses a fresh result key", async () => {
  const { page, sessionStorage, open } = openOpportunity();
  dialogReturns(page, sessionStorage, undefined);
  await open("opportunities");
  await open("opportunities");
  const keys = navigateCalls(page).map((call) => JSON.parse(call.pageInput.data).resultKey);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  noScriptErrors(page);
});

test("a confirmed result becomes a note on the record", async () => {
  const { page, sessionStorage, open } = openOpportunity();
  dialogReturns(page, sessionStorage, { confirmed: true, title: "Call back", text: "Asked for the revised quote." });
  page.xrm.webApi.respond("createRecord", () => NOTE_ID);

  assert.equal(await open("opportunities"), NOTE_ID);
  assert.deepStrictEqual(createCalls(page), [
    {
      api: "WebApi.createRecord",
      entityName: "annotation",
      data: {
        subject: "Call back",
        notetext: "Asked for the revised quote.",
        [BIND_KEY]: "/opportunities(" + RECORD_ID + ")",
      },
    },
  ]);
  assert.deepEqual(page.form.formNotifications, { kh_quicknote: { message: "Note added.", level: "INFO" } });
  assert.deepEqual(sessionStorage.snapshot(), {}, "the handoff entry is removed");
  noScriptErrors(page);
});

test("an empty title leaves out the subject", async () => {
  const { page, sessionStorage, open } = openOpportunity();
  dialogReturns(page, sessionStorage, { confirmed: true, title: "  ", text: "Untitled note." });
  page.xrm.webApi.respond("createRecord", () => NOTE_ID);

  await open("opportunities");
  assert.deepStrictEqual(createCalls(page)[0].data, {
    notetext: "Untitled note.",
    [BIND_KEY]: "/opportunities(" + RECORD_ID + ")",
  });
  noScriptErrors(page);
});

test("closing without a result creates nothing and leaves no entry", async () => {
  const results = [
    undefined,
    "{not json",
    { confirmed: false, title: "x", text: "Cancelled." },
    { confirmed: true, title: "x", text: "   " },
    { confirmed: true, title: "x" },
  ];
  for (const result of results) {
    const { page, sessionStorage, open } = openOpportunity();
    page.form.formContext.ui.setFormNotification("An older message.", "ERROR", "kh_quicknote");
    dialogReturns(page, sessionStorage, result);

    assert.equal(await open("opportunities"), null, JSON.stringify(result));
    assert.deepEqual(createCalls(page), []);
    assert.deepEqual(sessionStorage.snapshot(), {});
    assert.deepEqual(page.form.formNotifications, {}, "its own notification is cleared first");
    noScriptErrors(page);
  }
});

test("a failed note still removes the entry and shows an error", async () => {
  const { page, sessionStorage, open } = openOpportunity();
  dialogReturns(page, sessionStorage, { confirmed: true, title: "", text: "This one fails." });
  page.xrm.webApi.respond("createRecord", () => {
    throw xrmError("Notes are turned off for this table.");
  });

  assert.equal(await open("opportunities"), null);
  assert.deepEqual(sessionStorage.snapshot(), {});
  assert.deepEqual(page.form.formNotifications, {
    kh_quicknote: { message: "The note wasn't saved: Notes are turned off for this table.", level: "ERROR" },
  });
  noScriptErrors(page);
});

test("a dialog that can't open shows a form notification", async () => {
  const { page, sessionStorage, open } = openOpportunity();
  page.xrm.navigation.respondToNavigateTo(() => {
    throw xrmError("The web resource was not found.");
  });

  assert.equal(await open("opportunities"), null);
  assert.deepEqual(page.form.formNotifications, {
    kh_quicknote: { message: "The note dialog couldn't be opened: The web resource was not found.", level: "ERROR" },
  });
  assert.deepEqual(createCalls(page), []);
  assert.deepEqual(sessionStorage.snapshot(), {});
  noScriptErrors(page);
});

test("round trip: a note typed into the real dialog is created by the real opener", async () => {
  const { page, sessionStorage, open } = openOpportunity();
  let dialog;
  page.xrm.navigation.respondToNavigateTo((pageInput) => {
    // readdirSync compares names exactly; existsSync ignores case on Windows and macOS.
    assert.ok(fs.readdirSync(EXAMPLE_DIR).includes(pageInput.webresourceName), `${pageInput.webresourceName} is a shipped file`);
    const file = path.join(EXAMPLE_DIR, pageInput.webresourceName);
    dialog = openHtmlWebResource(file, { data: pageInput.data, sessionStorage });
    assert.equal(dialog.el("context").textContent, "Adds a note to Northwind renewal.");
    dialog.type("noteTitle", "Call back");
    dialog.type("noteText", "Asked for the revised quote by Friday.");
    dialog.click("save");
    assert.equal(dialog.closed, true);
    return undefined;
  });
  page.xrm.webApi.respond("createRecord", () => NOTE_ID);

  assert.equal(await open("opportunities"), NOTE_ID);
  assert.deepStrictEqual(createCalls(page)[0].data, {
    subject: "Call back",
    notetext: "Asked for the revised quote by Friday.",
    [BIND_KEY]: "/opportunities(" + RECORD_ID + ")",
  });
  assert.deepEqual(sessionStorage.snapshot(), {});
  assert.deepEqual(dialog.logs, []);
  noScriptErrors(page);
});

test("round trip: closing the real dialog with its X creates nothing", async () => {
  const { page, sessionStorage, open } = openOpportunity();
  page.xrm.navigation.respondToNavigateTo((pageInput) => {
    const dialog = openHtmlWebResource(path.join(EXAMPLE_DIR, pageInput.webresourceName), {
      data: pageInput.data,
      sessionStorage,
    });
    dialog.type("noteText", "Typed, then closed with the X.");
    return undefined;
  });

  assert.equal(await open("opportunities"), null);
  assert.deepEqual(createCalls(page), []);
  assert.deepEqual(sessionStorage.snapshot(), {});
  noScriptErrors(page);
});
