"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  createForm,
  openForm,
  deferred,
  fakeGuid,
  bracedId,
  xrmError,
  SAVE_MODE,
  SAVE_IN_PROGRESS,
  SAVE_CANCELLED,
} = require("../../harness");

const fixture = (name) => path.join(__dirname, "..", "fixtures", name);
const hostTurn = () => new Promise((resolve) => setImmediate(resolve));
const outcomes = (form) => form.saveAttempts.map((attempt) => [attempt.outcome, attempt.source]);

function accountForm(extra = {}) {
  return createForm({
    entityName: "account",
    id: fakeGuid(3),
    attributes: {
      name: "Fabrikam",
      accountnumber: { type: "string", value: "AC-1" },
      description: { type: "memo", value: null },
      websiteurl: { type: "string", value: "https://fabrikam.example.com" },
    },
    ...extra,
  });
}

test("OnSave handlers run in order and see the save mode", async () => {
  const form = accountForm();
  const { entity } = form.formContext.data;
  const seen = [];
  entity.addOnSave((context) => {
    seen.push(["first", context.getEventArgs().getSaveMode(), context.getEventSource() === entity]);
  });
  entity.addOnSave((context) => seen.push(["second", context.getEventArgs().getSaveMode()]));

  await form.userSave(SAVE_MODE.SAVE_AND_NEW);
  form.userEdit("name", "Fabrikam East");
  await form.formContext.data.save({ saveMode: SAVE_MODE.AUTOSAVE });

  assert.deepEqual(seen, [
    ["first", 59, true],
    ["second", 59],
    ["first", 70, true],
    ["second", 70],
  ]);
  assert.deepEqual(form.saves.map((save) => [save.saveMode, save.source]), [
    [59, "user"],
    [70, "script"],
  ]);
  assert.throws(() => entity.addOnSave("KhNamespace.onSave"), /addOnSave\(\) needs a function/);
});

test("isDefaultPrevented shows an earlier handler's preventDefault; the save is cancelled", async () => {
  const form = accountForm();
  const { entity } = form.formContext.data;
  let seenByLater;
  entity.addOnSave((context) => context.getEventArgs().preventDefault());
  entity.addOnSave((context) => {
    seenByLater = context.getEventArgs().isDefaultPrevented();
  });

  const attempt = await form.userSave();
  assert.equal(attempt.outcome, "prevented");
  assert.equal(seenByLater, true);
  assert.deepEqual(form.saves, []);

  form.userEdit("name", "Fabrikam East");
  await assert.rejects(form.formContext.data.save(), (error) => {
    assert.deepStrictEqual(error, { ...SAVE_CANCELLED });
    return true;
  });
  assert.deepEqual(outcomes(form), [
    ["prevented", "user"],
    ["prevented", "script"],
  ]);
});

test("preventDefault after the handler returns has no effect", async () => {
  const form = accountForm();
  form.formContext.data.entity.addOnSave(async (context) => {
    await null;
    context.getEventArgs().preventDefault();
  });

  const attempt = await form.userSave();
  assert.equal(attempt.outcome, "saved");
  assert.equal(attempt.latePreventDefault, true);
  assert.equal(attempt.returnedPromise, true);
  assert.equal(form.saves.length, 1);
});

test("data.save on a form with no unsaved data runs no OnSave handler and sends nothing", async () => {
  const form = accountForm();
  let handlerRuns = 0;
  form.formContext.data.entity.addOnSave(() => {
    handlerRuns += 1;
  });

  assert.equal(await form.formContext.data.save(), undefined);
  assert.equal(handlerRuns, 0);
  assert.deepEqual(form.saves, []);
  assert.deepEqual(outcomes(form), [["clean", "script"]]);

  await form.userSave();
  form.formContext.data.entity.save();
  await hostTurn();
  assert.equal(handlerRuns, 2, "the Save button and entity.save fire OnSave even with nothing changed");
});

test("a promise-returning handler holds the save open until it settles", async () => {
  const form = accountForm();
  const gate = deferred();
  form.formContext.data.entity.addOnSave(() => gate.promise);
  form.userEdit("name", "Fabrikam East");

  const saving = form.userSave();
  await hostTurn();
  assert.equal(form.isSaving, true);
  assert.deepEqual(form.saves, []);

  gate.resolve();
  const attempt = await saving;
  assert.equal(attempt.outcome, "saved");
  assert.equal(form.isSaving, false);
  assert.deepStrictEqual(form.saves, [{ saveMode: 1, source: "user", values: { name: "Fabrikam East" } }]);
});

test("a save started during another save is rejected with the observed error", async () => {
  const form = accountForm();
  let handlerRuns = 0;
  form.formContext.data.entity.addOnSave(() => {
    handlerRuns += 1;
  });
  form.userEdit("name", "Fabrikam East");

  const first = form.formContext.data.save();
  const second = form.formContext.data.save();
  await assert.rejects(second, (error) => {
    assert.deepStrictEqual(error, { errorCode: 2200000003, message: "Please wait while saving is completed" });
    return true;
  });
  await first;

  assert.equal(handlerRuns, 1, "no handler ran for the rejected save");
  assert.deepEqual(outcomes(form), [
    ["saved", "script"],
    ["busy", "script"],
  ]);
  assert.deepStrictEqual(form.saveAttempts[1].error, { ...SAVE_IN_PROGRESS });
  assert.equal(form.saves.length, 1);
});

test("the naive async OnSave handler never gets its save through", async () => {
  const page = openForm({
    libraries: [fixture("naive-async-onsave.js")],
    entityName: "account",
    id: fakeGuid(3),
    attributes: { name: "Fabrikam" },
    handlers: { onLoad: ["KhNaiveSave.onLoad"] },
  });
  let checks = 0;
  page.xrm.webApi.respondToExecute("kh_NaiveCheck", () => {
    checks += 1;
  });
  await page.fireOnLoad();

  page.form.userEdit("name", "Fabrikam East");
  await page.form.userSave();
  await page.settle();

  assert.equal(checks, 1);
  assert.equal(page.sandbox.get("khLastSaveError").errorCode, 2200000003);
  assert.deepEqual(page.form.saves, []);
  assert.deepEqual(outcomes(page.form), [
    ["prevented", "user"],
    ["busy", "script"],
  ]);
  assert.equal(page.form.attribute("name").getIsDirty(), true);
});

test("with async handlers switched off, a returned promise is ignored", async () => {
  const form = accountForm({ asyncSaveHandlers: false });
  const gate = deferred();
  form.formContext.data.entity.addOnSave(() => gate.promise);

  const attempt = await form.userSave();
  assert.equal(attempt.outcome, "saved");
  assert.equal(attempt.returnedPromise, true);
  assert.equal(form.saves.length, 1);
  assert.equal(form.isSaving, false);
  gate.resolve();
});

test("a throwing OnSave handler is recorded and the save continues", async () => {
  const form = accountForm();
  const { entity } = form.formContext.data;
  let laterRan = false;
  entity.addOnSave(() => {
    throw new Error("OnSave broke");
  });
  entity.addOnSave(async () => {
    throw new Error("async OnSave broke");
  });
  entity.addOnSave(() => {
    laterRan = true;
  });

  const attempt = await form.userSave();
  assert.equal(attempt.outcome, "saved");
  assert.equal(laterRan, true);
  assert.deepStrictEqual(form.scriptErrors, [
    { event: "onsave", error: { name: "Error", message: "OnSave broke" } },
    { event: "onsave", error: { name: "Error", message: "async OnSave broke" } },
  ]);
});

test('a commit sends dirty and "always" attributes, never "never" ones, and leaves the form clean', async () => {
  const form = accountForm();
  form.userEdit("name", "Fabrikam East");
  form.userEdit("description", "Internal note");
  form.attribute("description").setSubmitMode("never");
  form.attribute("accountnumber").setSubmitMode("always");

  await form.userSave();
  assert.deepStrictEqual(form.saves[0].values, { name: "Fabrikam East", accountnumber: "AC-1" });
  assert.equal(form.formContext.data.getIsDirty(), false);
  assert.equal(form.attribute("description").getIsDirty(), false);

  await form.userSave();
  assert.deepStrictEqual(form.saves[1].values, { accountnumber: "AC-1" }, "a clean form sends only always columns");
});

test("a create form gets an id and becomes an update form when saved", async () => {
  const form = createForm({ entityName: "lead", attributes: { subject: "Fleet renewal" } });
  const { formContext } = form;
  assert.equal(formContext.ui.getFormType(), 1);
  assert.equal(formContext.data.entity.getId(), "");

  await form.userSave();
  assert.equal(formContext.data.entity.getId(), bracedId(fakeGuid(1001)));
  assert.equal(formContext.ui.getFormType(), 2);
  await form.userSave();
  assert.equal(formContext.data.entity.getId(), bracedId(fakeGuid(1001)));
});

test("failNextSave rejects with the given error and keeps the form dirty", async () => {
  const form = accountForm();
  form.userEdit("name", "Fabrikam East");
  form.failNextSave(xrmError("Another user changed this record."));

  await assert.rejects(form.formContext.data.save(), (error) => {
    assert.deepStrictEqual(error, { errorCode: null, message: "Another user changed this record." });
    return true;
  });
  assert.equal(form.saveAttempts[0].outcome, "failed");
  assert.equal(form.formContext.data.getIsDirty(), true);
  assert.deepEqual(form.saves, []);

  form.failNextSave(xrmError("Still locked.", 7));
  const attempt = await form.userSave();
  assert.equal(attempt.outcome, "failed");
  assert.deepStrictEqual(attempt.error, { errorCode: 7, message: "Still locked." });

  await form.formContext.data.save();
  assert.equal(form.saves.length, 1, "each arm is used once");
});

test("entity.save maps its options to save modes and returns undefined", async () => {
  const form = accountForm();
  const { entity } = form.formContext.data;
  const modes = [];
  entity.addOnSave((context) => modes.push(context.getEventArgs().getSaveMode()));

  assert.equal(entity.save(), undefined);
  await hostTurn();
  assert.equal(entity.save("saveandclose"), undefined);
  await hostTurn();
  assert.equal(entity.save("saveandnew"), undefined);
  await hostTurn();

  assert.deepEqual(modes, [1, 2, 59]);
  assert.deepEqual(form.saves.map((save) => save.source), ["script", "script", "script"]);
  assert.throws(() => entity.save("close"), /takes nothing, "saveandclose" or "saveandnew"/);
  assert.throws(() => form.formContext.data.save({ saveMode: "70" }), /saveMode must be a number/);
});

test("refresh(false) discards unsaved values and applies server values", async () => {
  const form = accountForm();
  form.userEdit("name", "Unsaved name");
  form.userEdit("websiteurl", "https://fabrikam.example.com/draft");
  form.setServerValues({ websiteurl: "https://fabrikam.example.com/live" });

  const refreshing = form.formContext.data.refresh(false);
  assert.equal(form.value("name"), "Unsaved name", "nothing changes before the round trip");
  assert.deepEqual(form.refreshes, []);
  assert.equal(await refreshing, undefined);
  assert.equal(form.value("name"), "Fabrikam");
  assert.equal(form.value("websiteurl"), "https://fabrikam.example.com/live");
  assert.equal(form.formContext.data.getIsDirty(), false);
  assert.deepEqual(form.refreshes, [{ save: false }]);
  assert.deepEqual(form.saves, []);

  await form.formContext.data.refresh();
  assert.equal(form.value("websiteurl"), "https://fabrikam.example.com/live", "server values are applied once");
  assert.throws(() => form.setServerValues({ name: 5 }), /needs a string or null/);
});

test("refresh(true) saves first and fails if the save fails", async () => {
  const form = accountForm();
  form.userEdit("name", "Fabrikam East");
  await form.formContext.data.refresh(true);
  assert.deepStrictEqual(form.saves, [{ saveMode: 1, source: "script", values: { name: "Fabrikam East" } }]);
  assert.deepEqual(form.refreshes, [{ save: true }]);
  assert.equal(form.value("name"), "Fabrikam East");

  form.userEdit("name", "Fabrikam West");
  form.failNextSave(xrmError("The save failed."));
  await assert.rejects(form.formContext.data.refresh(true), { errorCode: null, message: "The save failed." });
  assert.equal(form.refreshes.length, 1, "no reload after a failed save");
  assert.equal(form.value("name"), "Fabrikam West");

  await form.formContext.data.refresh(false);
  await form.formContext.data.refresh(true);
  assert.equal(form.saves.length, 1, "a clean form is not saved by refresh(true)");
  assert.deepEqual(form.refreshes, [{ save: true }, { save: false }, { save: true }]);
});
