"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createForm, createSandbox, fakeGuid, bracedId } = require("../../harness");

const ACCOUNT_ID = fakeGuid(9);
const BIRTHDATE = new Date(Date.UTC(1990, 0, 2));

function contactForm() {
  return createForm({
    entityName: "contact",
    id: fakeGuid(1),
    primaryAttribute: "fullname",
    attributes: {
      fullname: "Dana Lee",
      firstname: "Dana",
      donotemail: false,
      birthdate: BIRTHDATE,
      parentcustomerid: [{ id: bracedId(ACCOUNT_ID), entityType: "account", name: "Fabrikam" }],
      numberofchildren: { type: "integer", value: 2 },
      creditlimit: { type: "money", value: 1500.5 },
      description: { type: "memo", value: null },
      preferredcontactmethodcode: {
        type: "optionset",
        value: 1,
        options: [
          { value: 1, text: "Any" },
          { value: 2, text: "Email" },
          { value: 3, text: "Phone" },
        ],
      },
    },
  });
}

test("types come from specs and shorthands; bare numbers are refused", () => {
  const { formContext } = contactForm();
  const types = Object.fromEntries(formContext.getAttribute().map((a) => [a.getName(), a.getAttributeType()]));
  assert.deepEqual(types, {
    fullname: "string",
    firstname: "string",
    donotemail: "boolean",
    birthdate: "datetime",
    parentcustomerid: "lookup",
    numberofchildren: "integer",
    creditlimit: "money",
    description: "memo",
    preferredcontactmethodcode: "optionset",
  });

  const declare = (attributes) => () => createForm({ entityName: "contact", attributes });
  assert.throws(declare({ numberofchildren: 2 }), /integer, decimal, double, money and optionset all hold numbers/);
  assert.throws(declare({ creditlimit: null }), /a bare null doesn't say which type it is/);
  assert.throws(declare({ creditlimit: { type: "currency" } }), /type must be one of/);
  assert.throws(declare({ firstname: { type: "string", vaule: "typo" } }), /unknown option "vaule"/);
  assert.throws(declare({ firstname: { type: "string", value: 5 } }), /needs a string or null/);
});

test("lookup values are arrays of { id, name, entityType }", () => {
  const form = contactForm();
  const lookup = form.formContext.getAttribute("parentcustomerid");
  assert.deepStrictEqual(lookup.getValue(), [{ id: bracedId(ACCOUNT_ID), entityType: "account", name: "Fabrikam" }]);
  assert.equal(form.formContext.getControl("parentcustomerid").getControlType(), "lookup");

  lookup.setValue([{ id: bracedId(fakeGuid(10)), entityType: "account" }]);
  assert.deepStrictEqual(form.value("parentcustomerid"), [{ id: bracedId(fakeGuid(10)), entityType: "account" }]);
  lookup.setValue(null);
  assert.equal(lookup.getValue(), null);
});

test("setValue does not run OnChange; fireOnChange does, with an execution context", () => {
  const form = contactForm();
  const attribute = form.formContext.getAttribute("firstname");
  const seen = [];
  attribute.addOnChange((context) => {
    seen.push({ source: context.getEventSource(), form: context.getFormContext(), args: context.getEventArgs() });
  });

  attribute.setValue("Robin");
  assert.equal(seen.length, 0);
  attribute.fireOnChange();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, attribute);
  assert.equal(seen[0].form, form.formContext);
  assert.equal(seen[0].args, null);
});

test("userEdit fires OnChange only when the value changes", () => {
  const form = contactForm();
  let changes = 0;
  form.attribute("firstname").addOnChange(() => {
    changes += 1;
  });
  form.attribute("parentcustomerid").addOnChange(() => {
    changes += 100;
  });

  form.userEdit("firstname", "Dana");
  assert.equal(changes, 0);
  form.userEdit("firstname", "Robin");
  form.userEdit("firstname", "Robin");
  assert.equal(changes, 1);

  form.userEdit("parentcustomerid", [{ id: ACCOUNT_ID, entityType: "account", name: "Fabrikam" }]);
  assert.equal(changes, 1, "same record, id written without braces or upper case");
  form.userEdit("parentcustomerid", [{ id: fakeGuid(10), entityType: "account" }]);
  assert.equal(changes, 101);
});

test("dirty means different from the loaded value", () => {
  const form = contactForm();
  const { formContext } = form;
  const firstname = form.attribute("firstname");

  assert.equal(firstname.getIsDirty(), false);
  firstname.setValue("Robin");
  assert.equal(firstname.getIsDirty(), true);
  assert.equal(formContext.data.entity.getIsDirty(), true);
  firstname.setValue("Dana");
  assert.equal(firstname.getIsDirty(), false, "edit then revert is clean");
  assert.equal(formContext.data.getIsDirty(), false);

  const lookup = form.attribute("parentcustomerid");
  lookup.setValue([{ id: ACCOUNT_ID, entityType: "account", name: "another label" }]);
  assert.equal(lookup.getIsDirty(), false, "ids compare without braces or case; names are ignored");
  lookup.setValue([{ id: ACCOUNT_ID, entityType: "contact" }]);
  assert.equal(lookup.getIsDirty(), true);

  const birthdate = form.attribute("birthdate");
  birthdate.setValue(new Date(BIRTHDATE.getTime()));
  assert.equal(birthdate.getIsDirty(), false, "datetimes compare by time");
  birthdate.setValue(new Date(BIRTHDATE.getTime() + 1));
  assert.equal(birthdate.getIsDirty(), true);
});

test("setValue rejects values of the wrong type", () => {
  const form = contactForm();
  const set = (name, value) => () => form.attribute(name).setValue(value);

  assert.throws(set("creditlimit", "1500"), { name: "TypeError", message: /setValue on creditlimit \(money\) needs a finite number/ });
  assert.throws(set("creditlimit", Number.NaN), TypeError);
  assert.throws(set("numberofchildren", 1.5), /needs a whole number/);
  assert.throws(set("preferredcontactmethodcode", 4), /needs one of its option values \(1, 2, 3\)/);
  assert.throws(set("parentcustomerid", [{ id: 5, entityType: "account" }]), /needs a string id on item 0/);
  assert.throws(set("parentcustomerid", [{ id: ACCOUNT_ID }]), /needs a string entityType on item 0/);
  assert.throws(set("parentcustomerid", { id: ACCOUNT_ID, entityType: "account" }), /needs an array/);
  assert.throws(set("donotemail", null), /null is not allowed for a boolean/);
  assert.throws(set("donotemail", "false"), /takes true or false/);
  assert.throws(set("birthdate", "1990-01-02"), /needs a valid Date/);
  assert.throws(set("birthdate", new Date("not a date")), /needs a valid Date/);
  assert.throws(set("firstname", undefined), /needs a string or null; got undefined/);
  assert.equal(form.value("creditlimit"), 1500.5, "a refused value leaves the old one");

  // With a realm, the TypeError comes from the sandbox, so sandbox code can catch it as its own.
  const sandbox = createSandbox();
  const sandboxed = createForm({
    entityName: "contact",
    attributes: { creditlimit: { type: "money", value: null } },
    realm: sandbox.realm,
  });
  sandbox.define("khForm", sandboxed.formContext);
  const caught = sandbox.run(
    "(() => { try { khForm.getAttribute('creditlimit').setValue('x'); } catch (e) { return e instanceof TypeError; } })()",
  );
  assert.equal(caught, true);
});

test("required level and submit mode accept only documented values", () => {
  const form = contactForm();
  const attribute = form.attribute("firstname");
  assert.equal(attribute.getRequiredLevel(), "none");
  assert.equal(attribute.getSubmitMode(), "dirty");

  attribute.setRequiredLevel("required");
  attribute.setSubmitMode("always");
  assert.equal(attribute.getRequiredLevel(), "required");
  assert.equal(attribute.getSubmitMode(), "always");
  attribute.setRequiredLevel("recommended");
  attribute.setSubmitMode("never");
  assert.equal(attribute.getRequiredLevel(), "recommended");
  assert.equal(attribute.getSubmitMode(), "never");

  assert.throws(() => attribute.setRequiredLevel("mandatory"), /setRequiredLevel\(\) takes none, required, recommended/);
  assert.throws(() => attribute.setSubmitMode(true), /setSubmitMode\(\) takes always, never, dirty/);
  assert.throws(
    () => createForm({ entityName: "contact", attributes: { firstname: { type: "string", requiredLevel: "high" } } }),
    /requiredLevel must be one of/,
  );
});

test("optionset getText and getSelectedOption", () => {
  const form = contactForm();
  const method = form.attribute("preferredcontactmethodcode");
  assert.equal(method.getText(), "Any");
  assert.deepStrictEqual(method.getSelectedOption(), { value: 1, text: "Any" });
  assert.equal(form.formContext.getControl("preferredcontactmethodcode").getControlType(), "optionset");

  method.setValue(2);
  assert.equal(method.getText(), "Email");
  method.setValue(null);
  assert.equal(method.getText(), null);
  assert.equal(method.getSelectedOption(), null);
  assert.equal(typeof form.attribute("firstname").getText, "undefined", "only optionsets have getText");
});

test("removeOnChange stops a handler; a throwing OnChange handler is recorded and the next one still runs", () => {
  const form = contactForm();
  const attribute = form.attribute("firstname");
  const ran = [];
  const removed = () => ran.push("removed");
  attribute.addOnChange(removed);
  attribute.addOnChange(() => {
    throw new Error("OnChange broke");
  });
  attribute.addOnChange(() => ran.push("after the broken one"));
  attribute.removeOnChange(removed);

  form.userEdit("firstname", "Robin");
  assert.deepEqual(ran, ["after the broken one"]);
  assert.deepStrictEqual(form.scriptErrors, [
    { event: "onchange", attribute: "firstname", error: { name: "Error", message: "OnChange broke" } },
  ]);
  assert.throws(() => attribute.addOnChange("KhNamespace.onChange"), /addOnChange\(\) needs a function/);
});

test("getAttribute: all, by name, by index, by delegate; unknown name is null", () => {
  const { formContext } = contactForm();
  const all = formContext.getAttribute();
  assert.equal(all.length, 9);
  assert.equal(formContext.getAttribute("firstname").getName(), "firstname");
  assert.equal(formContext.getAttribute(0).getName(), "fullname");
  assert.equal(formContext.getAttribute(99), null);
  assert.deepEqual(
    formContext.getAttribute((a) => a.getAttributeType() === "string").map((a) => a.getName()),
    ["fullname", "firstname"],
  );
  assert.equal(formContext.getAttribute("telephone1"), null, "a column not on the form is null, as on the platform");
});
