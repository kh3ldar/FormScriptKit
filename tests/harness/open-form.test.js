"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { openForm, createStorage, toHost, fakeGuid, bracedId, LOAD_STATE } = require("../../harness");

const fixture = (name) => path.join(__dirname, "..", "fixtures", name);
const HANDLERS = fixture("form-handlers.js");

function openAccount(options = {}) {
  return openForm({
    libraries: [HANDLERS],
    entityName: "account",
    id: fakeGuid(6),
    attributes: { name: "Fabrikam" },
    ...options,
  });
}

const probeLog = (page) => toHost(page.sandbox.get("khProbeLog"));

test("libraries load in order and configured handlers bind by name", async () => {
  const page = openAccount({
    handlers: { onLoad: ["KhProbe.onLoad"], onSave: ["KhProbe.onSave"], onChange: { name: ["KhProbe.onChange"] } },
  });
  assert.deepEqual(probeLog(page), [], "OnLoad doesn't run until the test fires it");

  page.form.userEdit("name", "Fabrikam East");
  await page.form.userSave();
  await page.fireOnLoad();
  assert.deepStrictEqual(probeLog(page), [
    { event: "onchange", attribute: "name" },
    { event: "onsave", formType: 2 },
    { event: "onload", formType: 2 },
  ]);

  const ordered = openForm({
    libraries: [fixture("globals-first.js"), fixture("namespace-second.js")],
    entityName: "account",
  });
  assert.equal(ordered.call("KhSample.shout"), "HELLO!");
  assert.deepEqual(ordered.sandbox.files.map((file) => path.basename(file)), ["globals-first.js", "namespace-second.js"]);
});

test("an unknown handler name fails when the form opens", () => {
  assert.throws(
    () => openAccount({ handlers: { onSave: ["KhProbe.onSaved"] } }),
    (error) => {
      assert.match(error.message, /"KhProbe\.onSaved" does not resolve/);
      assert.match(error.message, /"onSaved" is undefined after loading form-handlers\.js/);
      return true;
    },
  );
  assert.throws(() => openAccount({ handlers: { onChange: { telephone1: ["KhProbe.onChange"] } } }), /no attribute "telephone1"/);
  assert.throws(() => openAccount({ handlers: { onload: ["KhProbe.onLoad"] } }), /handlers has no event "onload"/);
  assert.throws(() => openAccount({ libraries: [] }), /needs libraries/);
  assert.throws(() => openAccount({ library: HANDLERS }), /openForm has no option "library"/);
});

test("fireOnLoad passes an execution context and waits for async handlers", async () => {
  const page = openAccount({ id: undefined, handlers: { onLoad: ["KhProbe.onLoadAsync", "KhProbe.onLoad"] } });
  await page.fireOnLoad();
  assert.deepStrictEqual(probeLog(page), [
    { event: "onload", formType: 1 },
    { event: "onload-async", formType: 1 },
  ]);
  assert.deepEqual(page.form.scriptErrors, []);
});

test("OnLoad event args report load state 1 on the first load", async () => {
  const page = openAccount({ handlers: { onLoad: ["KhProbe.recordLoadState"] } });
  await page.fireOnLoad();
  assert.deepStrictEqual(probeLog(page), [{ event: "onload-state", loadState: LOAD_STATE.INITIAL, formType: 2 }]);
  assert.deepEqual(page.loads, [{ loadState: 1 }]);
  assert.deepEqual(page.form.scriptErrors, []);
});

test("a create form's first save fires OnLoad again with load state 2; later saves don't", async () => {
  const page = openAccount({ id: undefined, handlers: { onLoad: ["KhProbe.recordLoadState"] } });
  await page.fireOnLoad();
  page.form.userEdit("name", "Fabrikam East");
  await page.form.userSave();

  assert.deepStrictEqual(probeLog(page), [
    { event: "onload-state", loadState: 1, formType: 1 },
    { event: "onload-state", loadState: 2, formType: 2 },
  ]);
  assert.equal(page.form.formContext.data.entity.getId(), bracedId(fakeGuid(1001)));
  assert.equal(page.form.isSaving, false);

  page.form.userEdit("name", "Fabrikam West");
  await page.form.userSave();
  await page.form.formContext.data.refresh();
  assert.deepEqual(page.loads, [{ loadState: 1 }, { loadState: 2 }], "neither an update save nor refresh fires OnLoad");
});

test("onLoadAfterCreate: false keeps OnLoad to the test's own fireOnLoad calls", async () => {
  const page = openAccount({ id: undefined, onLoadAfterCreate: false, handlers: { onLoad: ["KhProbe.recordLoadState"] } });
  await page.fireOnLoad();
  page.form.userEdit("name", "Fabrikam East");
  await page.form.userSave();
  assert.deepEqual(page.loads, [{ loadState: 1 }]);
  assert.equal(page.form.formContext.ui.getFormType(), 2);
  assert.throws(() => openAccount({ onLoadAfterCreate: "no" }), /onLoadAfterCreate must be true or false/);
});

test("handler errors are recorded, not thrown", async () => {
  const page = openAccount({ handlers: { onLoad: ["KhProbe.throwOnLoad", "KhProbe.rejectOnLoad", "KhProbe.onLoad"] } });
  await page.fireOnLoad();

  assert.deepStrictEqual(page.form.scriptErrors, [
    { event: "onload", error: { name: "Error", message: "KhProbe.throwOnLoad failed on purpose" } },
    { event: "onload", error: { name: "Error", message: "KhProbe.rejectOnLoad failed on purpose" } },
  ]);
  assert.deepEqual(
    probeLog(page).map((entry) => entry.event),
    ["onload-throw", "onload", "onload-reject"],
    "the handlers after the failing one still ran",
  );
});

test("libraries see the same Xrm, timers and storages the test holds", () => {
  const sessionStorage = createStorage();
  sessionStorage.setItem("kh_probe", "shared");
  const page = openAccount({ sessionStorage });

  const seen = toHost(page.call("KhProbe.readsSharedState"));
  assert.equal(seen.sameXrm, true);
  assert.equal(seen.stored, "shared");
  assert.equal(page.timers.pending, 1, "the library's setTimeout landed on the test's timers");
  assert.equal(page.sandbox.get("Xrm"), page.xrm.Xrm);
  assert.equal(page.sandbox.timers, page.timers);
  assert.equal(page.sandbox.sessionStorage, sessionStorage);
  assert.equal(page.sandbox.get("localStorage"), page.sandbox.localStorage);
});
