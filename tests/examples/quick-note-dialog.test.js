"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openHtmlWebResource, extractScripts, createStorage } = require("../../harness");

const DIALOG = path.join(__dirname, "..", "..", "examples", "quick-note-dialog", "kh_quicknotedialog.html");
const RESULT_KEY = "kh_quicknote_t1";
const INPUT = { resultKey: RESULT_KEY, recordName: "Northwind renewal" };
const MSG_NO_KEY = "Open this dialog from a record to add a note.";

function openDialog(input = INPUT, options = {}) {
  const sessionStorage = options.sessionStorage || createStorage();
  const dialog = openHtmlWebResource(DIALOG, { data: JSON.stringify(input), ...options, sessionStorage });
  return { dialog, sessionStorage };
}

const stored = (sessionStorage) => {
  const raw = sessionStorage.getItem(RESULT_KEY);
  return raw === null ? null : JSON.parse(raw);
};

test("the context line shows the record name as text", () => {
  const { dialog } = openDialog();
  assert.equal(dialog.el("context").textContent, "Adds a note to Northwind renewal.");
  assert.equal(dialog.el("error").textContent, "");
  assert.equal(dialog.el("save").disabled, false);
  assert.equal(dialog.document.title, "Quick note");

  const markup = openDialog({ resultKey: RESULT_KEY, recordName: "<b>Bold</b> & co" }).dialog;
  assert.equal(markup.el("context").textContent, "Adds a note to <b>Bold</b> & co.", "set as text, never parsed");

  const unnamed = openDialog({ resultKey: RESULT_KEY }).dialog;
  assert.equal(unnamed.el("context").textContent, "Adds a note to this record.");
});

test("a data value URL-encoded one extra time still works", () => {
  const sessionStorage = createStorage();
  // URLSearchParams encodes the already-encoded JSON again, so the page's
  // first decode leaves percent signs behind.
  const query = new URLSearchParams({ data: encodeURIComponent(JSON.stringify(INPUT)) });
  const dialog = openHtmlWebResource(DIALOG, { search: "?" + query, sessionStorage });
  assert.equal(dialog.el("context").textContent, "Adds a note to Northwind renewal.");

  dialog.type("noteText", "Encoded twice, read once.");
  dialog.click("save");
  assert.equal(stored(sessionStorage).text, "Encoded twice, read once.");
});

test("without a result key the dialog can't return anything", () => {
  const variants = [
    { data: JSON.stringify({ recordName: "Northwind renewal" }) },
    { data: JSON.stringify({ resultKey: "" }) },
    { data: "not json" },
    { data: JSON.stringify(["kh_quicknote_t1"]) },
    {},
  ];
  for (const options of variants) {
    const sessionStorage = createStorage();
    const dialog = openHtmlWebResource(DIALOG, { ...options, sessionStorage });
    assert.equal(dialog.el("error").textContent, MSG_NO_KEY, JSON.stringify(options));
    assert.equal(dialog.el("save").disabled, true);

    dialog.type("noteText", "This note has nowhere to go.");
    dialog.click("save");
    assert.deepEqual(sessionStorage.snapshot(), {});
    assert.equal(dialog.closeCalls, 0);

    dialog.click("cancel");
    assert.equal(dialog.closeCalls, 1, "cancel still closes");
  }
});

test("an empty note is refused with a message and focus on the note", () => {
  const { dialog, sessionStorage } = openDialog();
  dialog.type("noteTitle", "Call back");
  dialog.type("noteText", "   ");
  dialog.click("save");

  assert.equal(dialog.el("error").textContent, "Write the note before adding it.");
  assert.equal(dialog.document.activeElement, dialog.el("noteText"));
  assert.deepEqual(sessionStorage.snapshot(), {});
  assert.equal(dialog.closeCalls, 0);
});

test("Add note stores the trimmed result under the key, then closes", () => {
  const { dialog, sessionStorage } = openDialog();
  dialog.click("save");
  assert.equal(dialog.el("error").textContent, "Write the note before adding it.");

  dialog.type("noteTitle", "  Call back  ");
  dialog.type("noteText", "  Asked for the revised quote by Friday.  ");
  dialog.click("save");

  assert.deepStrictEqual(stored(sessionStorage), {
    confirmed: true,
    title: "Call back",
    text: "Asked for the revised quote by Friday.",
  });
  assert.equal(dialog.el("error").textContent, "", "the earlier error is cleared");
  assert.equal(dialog.closeCalls, 1);
  assert.equal(dialog.closed, true);
});

test("an empty title is stored as an empty string", () => {
  const { dialog, sessionStorage } = openDialog();
  dialog.type("noteText", "No title on this one.");
  dialog.click("save");
  assert.deepStrictEqual(stored(sessionStorage), { confirmed: true, title: "", text: "No title on this one." });
});

test("blocked session storage shows an error and keeps the dialog open", () => {
  const { dialog, sessionStorage } = openDialog();
  sessionStorage.blocked = true;
  dialog.type("noteText", "This can't be handed back.");
  dialog.click("save");

  assert.equal(
    dialog.el("error").textContent,
    "This browser blocked session storage, so the note can't be handed back to the form.",
  );
  assert.equal(dialog.closeCalls, 0);
  assert.deepEqual(sessionStorage.snapshot(), {});
});

test("Cancel withdraws an earlier result and closes", () => {
  const { dialog, sessionStorage } = openDialog();
  dialog.type("noteText", "Changed my mind.");
  dialog.click("save");
  assert.notEqual(stored(sessionStorage), null);

  // The host ignored close(), so the dialog is still there and the user cancels.
  dialog.click("cancel");
  assert.equal(stored(sessionStorage), null);
  assert.equal(dialog.closeCalls, 2);

  const blocked = openDialog();
  blocked.sessionStorage.blocked = true;
  blocked.dialog.click("cancel");
  assert.equal(blocked.dialog.closeCalls, 1, "a storage error doesn't stop the cancel");
});

test("the page never reaches into other frames", () => {
  const scripts = extractScripts(fs.readFileSync(DIALOG, "utf8"));
  assert.equal(scripts.length, 1);
  const [script] = scripts;
  assert.equal(script.src, null);
  for (const needle of ["window.top", "window.parent", "parent.", "top.", "opener", "Xrm"]) {
    assert.ok(!script.code.includes(needle), `the dialog script mentions ${needle}`);
  }
});
