"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createForm, createXrm, fakeGuid, FORM_TYPE } = require("../../harness");

function accountForm(extra = {}) {
  return createForm({
    entityName: "account",
    id: fakeGuid(5),
    attributes: {
      name: "Fabrikam",
      telephone1: { type: "string", value: null, label: "Main Phone", controls: ["telephone1", "header_telephone1"] },
      accountnumber: { type: "string", value: "AC-1", controls: false },
      primarycontactid: { type: "lookup", value: null },
      industrycode: { type: "optionset", value: null, options: [{ value: 1, text: "Accounting" }] },
    },
    ...extra,
  });
}

test("each attribute gets a control of the same name unless told otherwise", () => {
  const { formContext } = accountForm();
  assert.equal(formContext.getControl("name").getAttribute(), formContext.getAttribute("name"));
  assert.equal(formContext.getControl("header_telephone1").getAttribute().getName(), "telephone1");
  assert.equal(formContext.getControl("accountnumber"), null);
  assert.equal(formContext.getAttribute("accountnumber").controls.getLength(), 0);
  assert.equal(formContext.getControl("websiteurl"), null);

  assert.deepEqual(
    formContext.getControl().map((c) => [c.getName(), c.getControlType()]),
    [
      ["name", "standard"],
      ["telephone1", "standard"],
      ["header_telephone1", "standard"],
      ["primarycontactid", "lookup"],
      ["industrycode", "optionset"],
    ],
  );
  assert.equal(formContext.getControl(1).getName(), "telephone1");
  assert.equal(formContext.getControl((c) => c.getControlType() === "lookup").length, 1);
});

test("controls track visibility, disabled state and label; non-booleans are refused", () => {
  const { formContext } = accountForm();
  const control = formContext.getControl("telephone1");
  assert.equal(control.getLabel(), "Main Phone");
  assert.equal(formContext.getControl("name").getLabel(), "name", "the logical name when no label is given");
  assert.equal(control.getVisible(), true);
  assert.equal(control.getDisabled(), false);

  control.setVisible(false);
  control.setDisabled(true);
  control.setLabel("Phone");
  assert.equal(control.getVisible(), false);
  assert.equal(control.getDisabled(), true);
  assert.equal(control.getLabel(), "Phone");
  assert.equal(formContext.getControl("header_telephone1").getVisible(), true, "each control has its own state");

  assert.throws(() => control.setVisible("false"), /setVisible\(\) takes true or false/);
  assert.throws(() => control.setDisabled(1), /setDisabled\(\) takes true or false/);
  assert.throws(() => control.setLabel(5), /setLabel\(\) needs a string/);

  const controls = formContext.getAttribute("telephone1").controls;
  const names = [];
  controls.forEach((c) => names.push(c.getName()));
  assert.deepEqual(names, ["telephone1", "header_telephone1"]);
  assert.equal(controls.get(1).getName(), "header_telephone1");
  assert.equal(controls.get("telephone1"), control);
  assert.equal(controls.get((c) => c.getName().startsWith("header_")).length, 1);
  assert.equal(controls.get().length, 2);

  const hidden = accountForm({ attributes: { name: { type: "string", value: "x", visible: false, disabled: true } } });
  assert.equal(hidden.formContext.getControl("name").getVisible(), false);
  assert.equal(hidden.formContext.getControl("name").getDisabled(), true);
});

test("control notifications set and clear by id or all at once", () => {
  const form = accountForm();
  const control = form.formContext.getControl("telephone1");
  assert.equal(control.setNotification("Use the international format.", "format"), true);
  control.setNotification("Needed for invoices.", "invoice");
  assert.deepEqual(form.controlNotifications("telephone1"), {
    format: "Use the international format.",
    invoice: "Needed for invoices.",
  });
  assert.deepEqual(form.controlNotifications("header_telephone1"), {});

  assert.equal(control.clearNotification("format"), true);
  assert.deepEqual(form.controlNotifications("telephone1"), { invoice: "Needed for invoices." });
  control.clearNotification();
  assert.deepEqual(form.controlNotifications("telephone1"), {});
  assert.throws(() => control.setNotification("No id"), /needs a uniqueId string/);
  assert.throws(() => form.controlNotifications("websiteurl"), /no control "websiteurl"/);
});

test("form notifications replace by id, clear by id, and refuse unknown levels", () => {
  const form = accountForm();
  const { ui } = form.formContext;
  assert.equal(ui.setFormNotification("Credit hold.", "WARNING", "credit"), true);
  ui.setFormNotification("Credit hold lifted.", "INFO", "credit");
  ui.setFormNotification("The address is incomplete.", "ERROR", "address");
  assert.deepEqual(form.formNotifications, {
    credit: { message: "Credit hold lifted.", level: "INFO" },
    address: { message: "The address is incomplete.", level: "ERROR" },
  });

  assert.equal(ui.clearFormNotification("credit"), true);
  assert.equal(ui.clearFormNotification("credit"), false);
  assert.equal(ui.clearFormNotification("never-set"), false);
  assert.deepEqual(Object.keys(form.formNotifications), ["address"]);

  assert.throws(() => ui.setFormNotification("x", "warning", "id"), /ERROR, WARNING or INFO/);
  assert.throws(() => ui.setFormNotification("x", "SUCCESS", "id"), /ERROR, WARNING or INFO/);
  assert.throws(() => ui.setFormNotification(5, "INFO", "id"), /message as a string/);
  assert.throws(() => ui.setFormNotification("x", "INFO"), /uniqueId string/);

  const snapshot = form.formNotifications;
  snapshot.address.message = "changed by the test";
  assert.equal(form.formNotifications.address.message, "The address is incomplete.", "the getter returns a fresh copy");
});

test("form type defaults follow the id; invalid types are refused", () => {
  assert.equal(createForm({ entityName: "lead", id: fakeGuid(2) }).formContext.ui.getFormType(), FORM_TYPE.UPDATE);
  assert.equal(createForm({ entityName: "lead" }).formContext.ui.getFormType(), FORM_TYPE.CREATE);
  assert.equal(createForm({ entityName: "lead", id: fakeGuid(2), formType: 3 }).formContext.ui.getFormType(), 3);
  assert.equal(createForm({ entityName: "lead", id: fakeGuid(2), formType: 6 }).formContext.ui.getFormType(), 6);
  assert.throws(() => createForm({ entityName: "lead", formType: 5 }), /formType must be one of 0, 1, 2, 3, 4, 6/);
  assert.throws(() => createForm({}), /needs an entityName/);
  assert.throws(() => createForm({ entityName: "lead", atributes: {} }), /no option "atributes"/);
});

test("tabs and sections expose visibility, display state and labels", () => {
  const { formContext } = accountForm({
    tabs: {
      summary: { label: "Summary", sections: { general: { label: "General" }, notes: { visible: false } } },
      details: { displayState: "collapsed", visible: false },
    },
  });
  const { tabs } = formContext.ui;
  assert.equal(tabs.getLength(), 2);
  assert.equal(tabs.get().length, 2);

  const summary = tabs.get("summary");
  assert.equal(summary.getLabel(), "Summary");
  assert.equal(summary.getDisplayState(), "expanded");
  const details = tabs.get(1);
  assert.equal(details.getName(), "details");
  assert.equal(details.getLabel(), "details");
  assert.equal(details.getDisplayState(), "collapsed");
  assert.deepEqual(tabs.get((tab) => !tab.getVisible()).map((tab) => tab.getName()), ["details"]);

  details.setDisplayState("expanded");
  details.setVisible(true);
  details.setLabel("Details");
  assert.equal(details.getDisplayState(), "expanded");
  assert.equal(details.getVisible(), true);
  assert.equal(details.getLabel(), "Details");
  assert.throws(() => details.setDisplayState("open"), /"expanded" or "collapsed"/);
  assert.throws(() => details.setVisible("yes"), /takes true or false/);

  const notes = summary.sections.get("notes");
  assert.equal(summary.sections.getLength(), 2);
  assert.equal(summary.sections.get(0).getLabel(), "General");
  assert.equal(notes.getVisible(), false);
  assert.equal(notes.getLabel(), "notes");
  assert.equal(notes.getParent(), summary);
  notes.setVisible(true);
  notes.setLabel("Notes");
  assert.equal(notes.getVisible(), true);
  assert.equal(notes.getLabel(), "Notes");
  assert.equal(summary.sections.get("missing"), null);
});

test("entity ids come back braced and uppercased; empty on a create form", () => {
  const id = fakeGuid(77);
  const braced = "{" + id.toUpperCase() + "}";
  const form = createForm({ entityName: "opportunity", id, attributes: { name: "Northwind renewal" } });
  const { entity } = form.formContext.data;

  assert.equal(entity.getId(), braced);
  assert.equal(createForm({ entityName: "opportunity", id: "{" + id + "}" }).formContext.data.entity.getId(), braced);
  assert.equal(entity.getEntityName(), "opportunity");
  assert.equal(entity.getPrimaryAttributeValue(), "Northwind renewal");
  assert.deepStrictEqual(entity.getEntityReference(), { entityType: "opportunity", id: braced, name: "Northwind renewal" });
  assert.equal(entity.getIsDirty(), false);
  form.userEdit("name", "Northwind renewal, phase 2");
  assert.equal(entity.getIsDirty(), true);

  const created = createForm({ entityName: "opportunity", attributes: { name: { type: "string", value: null } } });
  assert.equal(created.formContext.data.entity.getId(), "");
  assert.equal(created.formContext.data.entity.getPrimaryAttributeValue(), "");
  assert.equal(createForm({ entityName: "opportunity" }).formContext.data.entity.getPrimaryAttributeValue(), "");

  const contact = createForm({ entityName: "contact", primaryAttribute: "fullname", attributes: { fullname: "Dana Lee" } });
  assert.equal(contact.formContext.data.entity.getPrimaryAttributeValue(), "Dana Lee");
});

test("refreshRibbon is counted", () => {
  const form = accountForm();
  assert.equal(form.ribbonRefreshes, 0);
  form.formContext.ui.refreshRibbon();
  form.formContext.ui.refreshRibbon(true);
  assert.equal(form.ribbonRefreshes, 2);
});

test("formContext and Xrm carry none of the fixtures' test-only members", () => {
  const form = accountForm();
  const { formContext } = form;
  for (const member of ["userSave", "userEdit", "saves", "saveAttempts", "scriptErrors", "failNextSave", "value", "attribute"]) {
    assert.equal(member in formContext, false, member);
  }
  for (const member of ["saves", "isSaving", "refreshes", "setServerValues"]) {
    assert.equal(member in formContext.data, false, member);
  }
  assert.equal("formNotifications" in formContext.ui, false);
  for (const member of ["assign", "baseline", "commit", "handlers"]) {
    assert.equal(member in formContext.getAttribute("name"), false, member);
  }

  const xrm = createXrm();
  for (const member of Object.keys(xrm).filter((key) => key !== "Xrm")) {
    assert.equal(member in xrm.Xrm, false, member);
  }
  for (const member of ["respond", "respondToExecute"]) assert.equal(member in xrm.Xrm.WebApi, false, member);
  for (const member of ["respondToAlert", "answerConfirm", "respondToNavigateTo"]) {
    assert.equal(member in xrm.Xrm.Navigation, false, member);
  }
  for (const member of ["progressVisible", "progressMessage"]) assert.equal(member in xrm.Xrm.Utility, false, member);
});
