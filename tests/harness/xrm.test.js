"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createXrm,
  createSandbox,
  toHost,
  fakeGuid,
  bracedId,
  xrmError,
  xrmResponse,
} = require("../../harness");

const ACCOUNT_ID = fakeGuid(4);

function requestFor(operationName, extra = {}) {
  return {
    getMetadata: () => ({ boundParameter: null, operationType: 0, operationName, parameterTypes: {} }),
    ...extra,
  };
}

test("CRUD calls are recorded and answered by responders", async () => {
  const xrm = createXrm();
  const { WebApi } = xrm.Xrm;
  xrm.webApi.respond("retrieveRecord", (call) => ({ name: "Fabrikam", accountid: call.id, query: call.options }));
  xrm.webApi.respond("retrieveMultipleRecords", () => [{ name: "Fabrikam" }, { name: "Contoso" }]);
  xrm.webApi.respond("createRecord", () => undefined);
  xrm.webApi.respond("updateRecord", () => undefined);

  assert.deepStrictEqual(await WebApi.retrieveRecord("account", ACCOUNT_ID, "?$select=name"), {
    name: "Fabrikam",
    accountid: ACCOUNT_ID,
    query: "?$select=name",
  });
  assert.deepStrictEqual(await WebApi.online.retrieveMultipleRecords("account", "?$top=2", 2), {
    entities: [{ name: "Fabrikam" }, { name: "Contoso" }],
  });
  assert.deepStrictEqual(await WebApi.createRecord("contact", { firstname: "Dana" }), {
    entityType: "contact",
    id: fakeGuid(2001),
  });
  assert.deepStrictEqual(await WebApi.online.createRecord("contact", { firstname: "Robin" }), {
    entityType: "contact",
    id: fakeGuid(2002),
  });
  assert.deepStrictEqual(await WebApi.updateRecord("account", ACCOUNT_ID, { name: "Fabrikam East" }), {
    entityType: "account",
    id: ACCOUNT_ID,
  });

  assert.deepEqual(xrm.calls.map((call) => call.api), [
    "WebApi.retrieveRecord",
    "WebApi.retrieveMultipleRecords",
    "WebApi.createRecord",
    "WebApi.createRecord",
    "WebApi.updateRecord",
  ]);
  assert.deepStrictEqual(xrm.callsTo("WebApi.updateRecord"), [
    { api: "WebApi.updateRecord", entityName: "account", id: ACCOUNT_ID, data: { name: "Fabrikam East" } },
  ]);
  assert.deepStrictEqual(xrm.callsTo("WebApi.retrieveMultipleRecords")[0], {
    api: "WebApi.retrieveMultipleRecords",
    entityName: "account",
    options: "?$top=2",
    maxPageSize: 2,
  });
  assert.equal(WebApi.online.retrieveRecord, WebApi.retrieveRecord);

  xrm.webApi.respond("retrieveMultipleRecords", () => ({ entities: [], nextLink: "page-2" }));
  assert.deepStrictEqual(await WebApi.retrieveMultipleRecords("account"), { entities: [], nextLink: "page-2" });
  xrm.webApi.respond("createRecord", () => fakeGuid(300));
  assert.equal((await WebApi.createRecord("lead", { subject: "Fleet renewal" })).id, fakeGuid(300));
  assert.throws(() => xrm.webApi.respond("deleteRecord", () => {}), /takes one of retrieveRecord/);
});

test("an unscripted call rejects with a message naming it and is listed as unhandled", async () => {
  const xrm = createXrm();
  await assert.rejects(xrm.Xrm.WebApi.retrieveRecord("account", ACCOUNT_ID), {
    errorCode: null,
    message: "FormScriptKit: no fake response for WebApi.retrieveRecord(account)",
  });
  await assert.rejects(xrm.Xrm.WebApi.online.execute(requestFor("kh_Ping")), {
    message: "FormScriptKit: no fake response for WebApi.online.execute(kh_Ping)",
  });
  assert.deepEqual(xrm.unhandled.map((call) => call.api), ["WebApi.retrieveRecord", "WebApi.online.execute"]);
  assert.equal(xrm.calls.length, 2);
});

test("a responder's xrmError becomes the documented { errorCode, message } rejection", async () => {
  const xrm = createXrm();
  const { WebApi } = xrm.Xrm;
  xrm.webApi.respond("updateRecord", () => {
    throw xrmError("Access denied.", 7);
  });
  xrm.webApi.respond("retrieveRecord", async () => {
    throw new Error("The request timed out.");
  });
  xrm.webApi.respond("createRecord", () => Promise.reject("plain text"));

  await assert.rejects(WebApi.updateRecord("account", ACCOUNT_ID, {}), (error) => {
    assert.deepStrictEqual(error, { errorCode: 7, message: "Access denied." });
    return true;
  });
  await assert.rejects(WebApi.retrieveRecord("account", ACCOUNT_ID), (error) => {
    assert.deepStrictEqual(error, { errorCode: null, message: "The request timed out." });
    return true;
  });
  await assert.rejects(WebApi.createRecord("account", {}), { errorCode: null, message: "plain text" });
  assert.deepEqual(xrm.unhandled, []);
});

test("execute reads getMetadata from the prototype and records the operation", async () => {
  const sandbox = createSandbox();
  const xrm = createXrm({ realm: sandbox.realm });
  sandbox.define("Xrm", xrm.Xrm);
  xrm.webApi.respondToExecute("kh_ScoreLead", (call) => ({ Score: call.parameters.Weight * 2 }));

  const body = await sandbox.run(`
    (function () {
      function ScoreLeadRequest(leadId, weight) {
        this.LeadId = { guid: leadId };
        this.Weight = weight;
        this.describe = function () { return "not a parameter"; };
      }
      ScoreLeadRequest.prototype.getMetadata = function () {
        return {
          boundParameter: null,
          operationType: 0,
          operationName: "kh_ScoreLead",
          parameterTypes: {
            LeadId: { typeName: "Edm.Guid", structuralProperty: 1 },
            Weight: { typeName: "Edm.Int32", structuralProperty: 1 }
          }
        };
      };
      return Xrm.WebApi.online.execute(new ScoreLeadRequest("${fakeGuid(8)}", 21))
        .then(function (response) { return response.json(); });
    })()
  `);

  assert.equal(Object.getPrototypeOf(body), sandbox.realm.Object.prototype, "the body is built in the sandbox");
  assert.deepStrictEqual(toHost(body), { Score: 42 });
  assert.deepStrictEqual(xrm.callsTo("WebApi.online.execute"), [
    {
      api: "WebApi.online.execute",
      operationName: "kh_ScoreLead",
      operationType: 0,
      boundParameter: null,
      parameters: { LeadId: { guid: fakeGuid(8) }, Weight: 21 },
    },
  ]);
});

test("execute responses: JSON body, no-content 204, and explicit non-ok", async () => {
  const xrm = createXrm();
  const { execute } = xrm.Xrm.WebApi.online;
  xrm.webApi.respondToExecute("kh_WithBody", () => ({ Value: 1 }));
  xrm.webApi.respondToExecute("kh_NoBody", () => undefined);
  xrm.webApi.respondToExecute("kh_Broken", () =>
    xrmResponse({ error: { message: "The plug-in failed." } }, { status: 500, statusText: "Server Error" }),
  );

  const withBody = await execute(requestFor("kh_WithBody"));
  assert.equal(withBody.ok, true);
  assert.equal(withBody.status, 200);
  assert.equal(withBody.statusText, "OK");
  assert.match(withBody.url, /\/api\/data\/v9\.2\/kh_WithBody$/);
  assert.deepStrictEqual(await withBody.json(), { Value: 1 });
  assert.equal(await withBody.text(), '{"Value":1}');

  const noBody = await execute(requestFor("kh_NoBody"));
  assert.equal(noBody.ok, true);
  assert.equal(noBody.status, 204);
  assert.equal(noBody.statusText, "No Content");
  assert.equal(await noBody.text(), "");
  await assert.rejects(noBody.json(), SyntaxError);

  const broken = await execute(requestFor("kh_Broken"));
  assert.equal(broken.ok, false);
  assert.equal(broken.status, 500);
  assert.equal(broken.statusText, "Server Error");
  assert.deepStrictEqual(await broken.json(), { error: { message: "The plug-in failed." } });

  assert.equal(xrmResponse(undefined, { status: 404 }).statusText, "Not Found");
  assert.equal(xrmResponse({}).ok, true);
  assert.throws(() => xrmResponse({}, { status: 42 }), /HTTP status/);
});

test("execute refuses a request without getMetadata or with bad metadata", async () => {
  const xrm = createXrm();
  const { execute } = xrm.Xrm.WebApi.online;
  const withMetadata = (metadata) => ({ getMetadata: () => metadata });

  await assert.rejects(execute({ QuoteId: "x" }), { errorCode: null, message: "FormScriptKit: the request has no getMetadata()" });
  await assert.rejects(execute(withMetadata({ operationType: 0, parameterTypes: {} })), { message: /no operationName string/ });
  await assert.rejects(
    execute(withMetadata({ operationName: "kh_Test", operationType: 3, parameterTypes: {} })),
    { message: /operationType must be 0 \(action\), 1 \(function\) or 2 \(CRUD\)/ },
  );
  await assert.rejects(execute(withMetadata({ operationName: "kh_Test", operationType: 0 })), { message: /no parameterTypes object/ });
  await assert.rejects(
    execute({
      getMetadata() {
        throw new Error("metadata broke");
      },
    }),
    { message: /getMetadata\(\) threw: metadata broke/ },
  );
  assert.equal(xrm.calls.length, 5, "malformed calls are still recorded");
  assert.deepEqual(xrm.unhandled, [], "malformed is not the same as unscripted");
});

test("execute refuses an action or function request whose properties aren't declared parameters", async () => {
  const xrm = createXrm();
  const { execute } = xrm.Xrm.WebApi.online;
  xrm.webApi.respondToExecute("kh_ScoreLead", () => ({ Score: 1 }));
  const declared = { LeadId: { typeName: "Edm.Guid", structuralProperty: 1 } };
  const request = (operationType, properties) => ({
    ...properties,
    getMetadata: () => ({ boundParameter: null, operationType, operationName: "kh_ScoreLead", parameterTypes: declared }),
  });

  await assert.rejects(execute(request(0, { LeadID: fakeGuid(9) })), {
    errorCode: null,
    message: 'FormScriptKit: request property "LeadID" is not declared in getMetadata().parameterTypes',
  });
  await assert.rejects(execute(request(1, { LeadId: { guid: fakeGuid(9) }, Weight: 2 })), { message: /"Weight" is not declared/ });
  assert.equal((await execute(request(0, { LeadId: { guid: fakeGuid(9) } }))).ok, true);

  xrm.webApi.respondToExecute("kh_ScoreLead", () => undefined);
  const crud = await execute(request(2, { etn: "lead", payload: { subject: "Fleet renewal" } }));
  assert.equal(crud.status, 204, "CRUD requests carry undeclared properties and are left alone");
  assert.deepEqual(xrm.unhandled, []);
});

test("execute refuses an Edm.Guid parameter passed as a bare string", async () => {
  const xrm = createXrm();
  const { execute } = xrm.Xrm.WebApi.online;
  xrm.webApi.respondToExecute("kh_ScoreLead", () => undefined);
  const request = (operationType, leadId) => ({
    LeadId: leadId,
    getMetadata: () => ({
      boundParameter: null,
      operationType,
      operationName: "kh_ScoreLead",
      parameterTypes: { LeadId: { typeName: "Edm.Guid", structuralProperty: 1 } },
    }),
  });

  for (const operationType of [0, 1]) {
    await assert.rejects(execute(request(operationType, fakeGuid(9))), {
      errorCode: null,
      message: 'FormScriptKit: request property "LeadId" is an Edm.Guid: pass { guid: "<id>" }, not a bare string',
    });
  }
  assert.equal((await execute(request(0, { guid: fakeGuid(9) }))).status, 204);
  assert.equal((await execute(request(0, null))).status, 204, "null is left to the server");
});

test("alert and confirm dialogs: required text, queued answers, loud when unanswered", async () => {
  const xrm = createXrm();
  const { Navigation } = xrm.Xrm;

  assert.equal(await Navigation.openAlertDialog({ text: "Saved." }, { height: 120 }), undefined);
  await assert.rejects(Navigation.openAlertDialog({ title: "No text" }), { message: /openAlertDialog needs alertStrings\.text/ });
  assert.deepStrictEqual(xrm.callsTo("Navigation.openAlertDialog")[0], {
    api: "Navigation.openAlertDialog",
    alertStrings: { text: "Saved." },
    alertOptions: { height: 120 },
  });
  xrm.navigation.respondToAlert((call) => `closed:${call.alertStrings.text}`);
  assert.equal(await Navigation.openAlertDialog({ text: "Again." }), "closed:Again.");

  xrm.navigation.answerConfirm(true, false);
  assert.deepStrictEqual(await Navigation.openConfirmDialog({ text: "Continue?" }), { confirmed: true });
  assert.deepStrictEqual(await Navigation.openConfirmDialog({ text: "Really?" }), { confirmed: false });
  await assert.rejects(Navigation.openConfirmDialog({ text: "And now?" }), {
    errorCode: null,
    message: "FormScriptKit: openConfirmDialog was called but the test queued no answer",
  });
  await assert.rejects(Navigation.openConfirmDialog({ title: "No text" }), { message: /confirmStrings\.text/ });
  assert.deepEqual(xrm.unhandled.map((call) => call.confirmStrings.text), ["And now?"]);
  assert.throws(() => xrm.navigation.answerConfirm("yes"), /takes booleans/);
});

test("navigateTo validates page input and options", async () => {
  const xrm = createXrm();
  const { navigateTo } = xrm.Xrm.Navigation;
  const page = { pageType: "webresource", webresourceName: "kh_page.html" };

  await assert.rejects(navigateTo({ ...page, data: { id: 1 } }), { message: /pageInput\.data must be a string/ });
  await assert.rejects(navigateTo({ pageType: "webresource" }), { message: /needs webresourceName as a non-empty string/ });
  await assert.rejects(navigateTo(page, { target: 2, width: { value: 50, unit: "em" } }), { message: /navigationOptions\.width/ });
  await assert.rejects(navigateTo(page, { target: 2, height: { unit: "px" } }), { message: /navigationOptions\.height/ });
  await assert.rejects(navigateTo(page, { target: 3 }), { message: /navigationOptions\.target must be 1 \(inline\) or 2 \(dialog\)/ });
  await assert.rejects(navigateTo(page, { position: 0 }), { message: /navigationOptions\.position/ });
  await assert.rejects(navigateTo(page, { title: 5 }), { message: /navigationOptions\.title/ });
  await assert.rejects(navigateTo({ pageType: "form" }), { message: /pageType must be one of/ });
  await assert.rejects(navigateTo({ pageType: "entityrecord" }), { message: /needs entityName/ });
  await assert.rejects(navigateTo({ pageType: "entitylist", entityName: "account" }, { target: 2 }), {
    message: /entitylist inline only/,
  });
  await assert.rejects(navigateTo({ pageType: "generative" }), { message: /needs pageId as a non-empty string/ });
  await assert.rejects(navigateTo({ pageType: "generative", pageId: "kh-page", data: "{}" }), {
    message: /generative takes data as an object/,
  });
  assert.deepEqual(xrm.unhandled, []);

  await assert.rejects(navigateTo(page), {
    errorCode: null,
    message: "FormScriptKit: no fake response for Navigation.navigateTo(webresource)",
  });
  assert.equal(xrm.unhandled.length, 1);

  let received;
  xrm.navigation.respondToNavigateTo((pageInput, navigationOptions) => {
    received = { pageInput, navigationOptions };
  });
  const input = { ...page, data: JSON.stringify({ id: 1 }) };
  const options = { target: 2, position: 1, width: { value: 50, unit: "%" }, height: 400, title: "Details" };
  assert.equal(await navigateTo(input, options), undefined);
  assert.deepStrictEqual(received, { pageInput: input, navigationOptions: options });
  assert.notEqual(received.pageInput, input, "the responder gets copies");

  assert.equal(await navigateTo(page, { target: 2, width: { value: 500 }, height: 400 }), undefined, "unit defaults to px");
  assert.equal(await navigateTo({ pageType: "entitylist", entityName: "account" }, { target: 1 }), undefined);
  xrm.navigation.respondToNavigateTo(() => ({ returnValue: { approved: true } }));
  assert.deepStrictEqual(
    await navigateTo({ pageType: "generative", pageId: "kh-page", recordId: fakeGuid(16), data: { mode: "review" } }, { target: 2 }),
    { returnValue: { approved: true } },
  );

  xrm.navigation.respondToNavigateTo(() => ({ savedEntityReference: [{ entityType: "contact", id: fakeGuid(15) }] }));
  assert.deepStrictEqual(await navigateTo({ pageType: "entityrecord", entityName: "contact" }, { target: 2 }), {
    savedEntityReference: [{ entityType: "contact", id: fakeGuid(15) }],
  });
});

test("progress indicator state and global context", () => {
  const xrm = createXrm({
    globalContext: {
      roles: [
        { id: fakeGuid(11), name: "Salesperson" },
        { id: fakeGuid(12), name: "Sales Manager" },
      ],
    },
  });
  const { Utility } = xrm.Xrm;

  assert.equal(xrm.utility.progressVisible, false);
  assert.equal(xrm.utility.progressMessage, null);
  Utility.showProgressIndicator("Working...");
  assert.equal(xrm.utility.progressVisible, true);
  assert.equal(xrm.utility.progressMessage, "Working...");
  Utility.closeProgressIndicator();
  assert.equal(xrm.utility.progressVisible, false);
  assert.equal(xrm.utility.progressMessage, "Working...", "the last message is kept");
  assert.deepStrictEqual(xrm.calls, [
    { api: "Utility.showProgressIndicator", message: "Working..." },
    { api: "Utility.closeProgressIndicator" },
  ]);

  const globalContext = Utility.getGlobalContext();
  assert.equal(globalContext.getClientUrl(), "https://contoso.crm.dynamics.com");
  assert.equal(globalContext.userSettings.userId, bracedId(fakeGuid(1)));
  assert.equal(globalContext.userSettings.userName, "Test User");
  assert.equal(globalContext.userSettings.languageId, 1033);
  const { roles } = globalContext.userSettings;
  assert.equal(roles.getLength(), 2);
  assert.equal(roles.get("Sales Manager").id, fakeGuid(12));
  assert.equal(roles.get(0).name, "Salesperson");
  assert.equal(roles.get((role) => role.name.startsWith("Sales")).length, 2);

  assert.equal(xrm.Xrm.Page, undefined);
  assert.equal("Page" in xrm.Xrm, false);
  assert.throws(() => createXrm({ globalContext: { clientURL: "x" } }), /no option "clientURL"/);
});

test("App.addGlobalNotification is recorded, validated against the documented shape, and resolves with a GUID", async () => {
  const xrm = createXrm();
  const { App } = xrm.Xrm;
  const id = await App.addGlobalNotification({ type: 2, level: 1, message: "Done.", showCloseButton: true });
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(xrm.callsTo("App.addGlobalNotification").map((call) => call.notification.message), ["Done."]);

  await assert.rejects(App.addGlobalNotification({ type: 1, level: 1, message: "toast" }), { message: /type must be 2/ });
  await assert.rejects(App.addGlobalNotification({ type: 2, level: 5, message: "x" }), { message: /level must be 1, 2, 3 or 4/ });
  await assert.rejects(App.addGlobalNotification({ type: 2, level: 1 }), { message: /message must be a string/ });
  await assert.rejects(App.addGlobalNotification(), { message: /needs a notification object/ });
});
