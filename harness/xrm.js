"use strict";

const {
  HOST_REALM,
  copyInto,
  toHost,
  fakeGuid,
  bracedId,
  xrmError,
  buildResponse,
  responseParts,
  createCollection,
} = require("./realm");

// A fake of the parts of the Xrm namespace a typical form script touches.
// Every call is recorded (as a host copy, in call order). Web API calls and
// dialogs are answered by responders the test registers. Unscripted Web API
// calls, confirm dialogs and navigations reject with a message naming the
// call; an alert with no responder resolves, as if the user closed it.

const CRUD_METHODS = Object.freeze(["retrieveRecord", "retrieveMultipleRecords", "createRecord", "updateRecord"]);
const PAGE_TYPES = Object.freeze(["entityrecord", "entitylist", "webresource", "dashboard", "custom", "generative"]);
const NOTIFICATION_LEVELS = Object.freeze([1, 2, 3, 4]);
const SIZE_UNITS = Object.freeze(["px", "%"]);
const FIRST_CREATED_ID = 2001;
const XRM_OPTIONS = new Set(["globalContext", "realm"]);
const CONTEXT_OPTIONS = new Set(["clientUrl", "userId", "userName", "languageId", "roles"]);

const isObject = (value) => value !== null && typeof value === "object";

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (isObject(value)) return Array.isArray(value) ? "an array" : "an object";
  return String(value);
}

// A number (pixels), or a SizeValue whose unit, when given, is "px" (the
// documented default) or "%".
function isSize(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (!isObject(value) || typeof value.value !== "number" || !Number.isFinite(value.value)) return false;
  return value.unit === undefined || SIZE_UNITS.includes(value.unit);
}

function checkNavigateTo(pageInput, navigationOptions) {
  if (!isObject(pageInput)) return "navigateTo needs a pageInput object";
  const { pageType } = pageInput;
  if (!PAGE_TYPES.includes(pageType)) {
    return `navigateTo pageInput.pageType must be one of ${PAGE_TYPES.join(", ")}; got ${show(pageType)}`;
  }
  if (pageType === "webresource") {
    if (typeof pageInput.webresourceName !== "string" || pageInput.webresourceName === "") {
      return "navigateTo with pageType webresource needs webresourceName as a non-empty string";
    }
    if (pageInput.data !== undefined && typeof pageInput.data !== "string") {
      return `navigateTo pageInput.data must be a string (JSON.stringify an object first); got ${show(pageInput.data)}`;
    }
  }
  if ((pageType === "entityrecord" || pageType === "entitylist") && typeof pageInput.entityName !== "string") {
    return `navigateTo with pageType ${pageType} needs entityName as a string`;
  }
  if (pageType === "custom" && typeof pageInput.name !== "string") {
    return "navigateTo with pageType custom needs name as a string";
  }
  if (pageType === "generative") {
    if (typeof pageInput.pageId !== "string" || pageInput.pageId === "") {
      return "navigateTo with pageType generative needs pageId as a non-empty string";
    }
    if (pageInput.data !== undefined && (!isObject(pageInput.data) || Array.isArray(pageInput.data))) {
      return `navigateTo with pageType generative takes data as an object; got ${show(pageInput.data)}`;
    }
  }
  if (navigationOptions === undefined) return null;
  if (!isObject(navigationOptions)) return "navigateTo navigationOptions must be an object when given";
  const { target, width, height, position, title } = navigationOptions;
  if (target !== undefined && target !== 1 && target !== 2) {
    return `navigationOptions.target must be 1 (inline) or 2 (dialog); got ${show(target)}`;
  }
  if (pageType === "entitylist" && target === 2) {
    return "navigateTo opens an entitylist inline only; target 2 (dialog) isn't supported for it";
  }
  for (const [key, size] of [
    ["width", width],
    ["height", height],
  ]) {
    if (size !== undefined && !isSize(size)) {
      return `navigationOptions.${key} must be a number or { value: number, unit?: "px" | "%" }`;
    }
  }
  if (position !== undefined && position !== 1 && position !== 2) {
    return `navigationOptions.position must be 1 (center) or 2 (side); got ${show(position)}`;
  }
  if (title !== undefined && typeof title !== "string") return "navigationOptions.title must be a string";
  return null;
}

function checkMetadata(metadata) {
  if (!isObject(metadata)) return "getMetadata() must return an object";
  if (typeof metadata.operationName !== "string" || metadata.operationName === "") {
    return "getMetadata() returned no operationName string";
  }
  if (![0, 1, 2].includes(metadata.operationType)) {
    return `getMetadata() operationType must be 0 (action), 1 (function) or 2 (CRUD); got ${show(metadata.operationType)}`;
  }
  if (!isObject(metadata.parameterTypes)) return "getMetadata() returned no parameterTypes object";
  return null;
}

// For an action or a function, every value the request carries must be a
// declared parameter; a misspelt property would never reach the server.
// CRUD requests (operationType 2) carry other properties, so they are left alone.
//
// An Edm.Guid value must be an object { guid: "<id>" }. Microsoft's execute
// page doesn't say so; it is the shape that the Dataverse REST Builder, a tool
// the page points to, generates, and a bare string was seen to arrive at the
// server as "undefined". The fake refuses the bare string.
function checkParameters(metadata, parameters) {
  if (metadata.operationType === 2) return null;
  for (const name of Object.keys(parameters)) {
    if (!Object.hasOwn(metadata.parameterTypes, name)) {
      return `request property "${name}" is not declared in getMetadata().parameterTypes`;
    }
  }
  for (const [name, value] of Object.entries(parameters)) {
    const type = metadata.parameterTypes[name];
    if (isObject(type) && type.typeName === "Edm.Guid" && typeof value === "string") {
      return `request property "${name}" is an Edm.Guid: pass { guid: "<id>" }, not a bare string`;
    }
  }
  return null;
}

/**
 * Creates an Xrm fixture. `fixture.Xrm` is the object to inject as the global
 * Xrm. Options: globalContext { clientUrl, userId, userName, languageId,
 * roles }, realm.
 */
function createXrm(options = {}) {
  for (const key of Object.keys(options)) {
    if (!XRM_OPTIONS.has(key)) throw new TypeError(`FormScriptKit: createXrm has no option "${key}"`);
  }
  const contextOptions = options.globalContext || {};
  for (const key of Object.keys(contextOptions)) {
    if (!CONTEXT_OPTIONS.has(key)) throw new TypeError(`FormScriptKit: globalContext has no option "${key}"`);
  }
  const {
    clientUrl = "https://contoso.crm.dynamics.com",
    userId = bracedId(fakeGuid(1)),
    userName = "Test User",
    languageId = 1033,
    roles = [],
  } = contextOptions;
  const realm = options.realm || null;
  const R = realm || HOST_REALM;
  const handOver = (value) => copyInto(value, R);

  const calls = [];
  const unhandled = [];
  const crudResponders = new Map();
  const executeResponders = new Map();
  const confirmAnswers = [];
  let alertResponder = null;
  let navigateResponder = null;
  let nextCreatedId = FIRST_CREATED_ID;
  const progress = { visible: false, message: null };

  function record(api, details = {}) {
    const entry = { api };
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) entry[key] = toHost(value);
    }
    calls.push(entry);
    return entry;
  }

  function toXrmError(error) {
    const shaped = new R.Object();
    if (isObject(error)) {
      shaped.errorCode = error.errorCode === undefined ? null : error.errorCode;
      shaped.message = error.message === undefined ? String(error) : String(error.message);
    } else {
      shaped.errorCode = null;
      shaped.message = String(error);
    }
    return shaped;
  }

  const resolved = (value) => new R.Promise((resolve) => resolve(value));
  const rejected = (message) => new R.Promise((resolve, reject) => reject(handOver(xrmError(message))));

  function unscripted(entry, label) {
    unhandled.push(entry);
    return rejected(`FormScriptKit: no fake response for ${label}`);
  }

  // Calls the responder at once, with a host copy of what was recorded, and
  // settles a sandbox-realm promise with its shaped result or its error.
  function answer(responder, args, shape) {
    return new R.Promise((resolve, reject) => {
      const fail = (error) => reject(toXrmError(error));
      let result;
      try {
        result = responder(...args);
      } catch (error) {
        fail(error);
        return;
      }
      Promise.resolve(result).then((value) => {
        let shaped;
        try {
          shaped = shape(value);
        } catch (error) {
          fail(error);
          return;
        }
        resolve(shaped);
      }, fail);
    });
  }

  function crud(method, entry, label, shape) {
    const responder = crudResponders.get(method);
    if (!responder) return unscripted(entry, `WebApi.${method}(${label})`);
    return answer(responder, [toHost(entry)], shape);
  }

  function requireEntityName(entityName, method) {
    return typeof entityName === "string" && entityName !== ""
      ? null
      : rejected(`FormScriptKit: WebApi.${method} needs the entity logical name as its first argument`);
  }

  const webApi = {
    retrieveRecord(entityName, id, queryOptions) {
      const entry = record("WebApi.retrieveRecord", { entityName, id, options: queryOptions });
      const refusal = requireEntityName(entityName, "retrieveRecord");
      if (refusal) return refusal;
      if (typeof id !== "string") return rejected("FormScriptKit: WebApi.retrieveRecord needs the id as a string");
      return crud("retrieveRecord", entry, entityName, handOver);
    },
    retrieveMultipleRecords(entityName, queryOptions, maxPageSize) {
      const entry = record("WebApi.retrieveMultipleRecords", { entityName, options: queryOptions, maxPageSize });
      const refusal = requireEntityName(entityName, "retrieveMultipleRecords");
      if (refusal) return refusal;
      return crud("retrieveMultipleRecords", entry, entityName, (value) =>
        handOver(Array.isArray(value) ? { entities: value } : value),
      );
    },
    createRecord(entityName, data) {
      const entry = record("WebApi.createRecord", { entityName, data });
      const refusal = requireEntityName(entityName, "createRecord");
      if (refusal) return refusal;
      if (!isObject(data)) return rejected("FormScriptKit: WebApi.createRecord needs a data object");
      return crud("createRecord", entry, entityName, (value) => {
        let id;
        if (value === undefined || value === null) {
          id = fakeGuid(nextCreatedId);
          nextCreatedId += 1;
        } else if (typeof value === "string") {
          id = value;
        } else if (isObject(value) && typeof value.id === "string") {
          id = value.id;
        } else {
          throw new Error("FormScriptKit: a createRecord responder returns an id string, { id }, or nothing");
        }
        return handOver({ entityType: entityName, id });
      });
    },
    updateRecord(entityName, id, data) {
      const entry = record("WebApi.updateRecord", { entityName, id, data });
      const refusal = requireEntityName(entityName, "updateRecord");
      if (refusal) return refusal;
      if (typeof id !== "string") return rejected("FormScriptKit: WebApi.updateRecord needs the id as a string");
      if (!isObject(data)) return rejected("FormScriptKit: WebApi.updateRecord needs a data object");
      return crud("updateRecord", entry, entityName, () => handOver({ entityType: entityName, id }));
    },
  };

  function execute(request) {
    let metadata;
    let problem = null;
    if (!isObject(request) && typeof request !== "function") {
      problem = "execute needs a request object";
    } else if (typeof request.getMetadata !== "function") {
      problem = "the request has no getMetadata()";
    } else {
      try {
        metadata = request.getMetadata();
        problem = checkMetadata(metadata);
      } catch (error) {
        problem = `getMetadata() threw: ${error && error.message}`;
      }
    }
    const parameters = {};
    if (isObject(request)) {
      for (const key of Object.keys(request)) {
        if (typeof request[key] !== "function") parameters[key] = request[key];
      }
    }
    if (!problem) problem = checkParameters(metadata, parameters);
    const known = isObject(metadata) ? metadata : {};
    const entry = record("WebApi.online.execute", {
      operationName: known.operationName,
      operationType: known.operationType,
      boundParameter: known.boundParameter,
      parameters,
    });
    if (problem) return rejected(`FormScriptKit: ${problem}`);

    const { operationName } = metadata;
    const responder = executeResponders.get(operationName);
    if (!responder) return unscripted(entry, `WebApi.online.execute(${operationName})`);
    const url = `${clientUrl}/api/data/v9.2/${operationName}`;
    return answer(responder, [toHost(entry)], (value) => {
      const parts = responseParts(value);
      if (parts) return buildResponse({ ...parts, url }, R);
      if (value === undefined) return buildResponse({ status: 204, statusText: "No Content", body: undefined, url }, R);
      return buildResponse({ status: 200, statusText: "OK", body: toHost(value), url }, R);
    });
  }

  const WebApi = { ...webApi, online: { ...webApi, execute } };

  const Navigation = {
    openAlertDialog(alertStrings, alertOptions) {
      const entry = record("Navigation.openAlertDialog", { alertStrings, alertOptions });
      if (!isObject(alertStrings) || typeof alertStrings.text !== "string") {
        return rejected("FormScriptKit: openAlertDialog needs alertStrings.text as a string");
      }
      if (!alertResponder) return resolved(undefined);
      return answer(alertResponder, [toHost(entry)], handOver);
    },
    openConfirmDialog(confirmStrings, confirmOptions) {
      const entry = record("Navigation.openConfirmDialog", { confirmStrings, confirmOptions });
      if (!isObject(confirmStrings) || typeof confirmStrings.text !== "string") {
        return rejected("FormScriptKit: openConfirmDialog needs confirmStrings.text as a string");
      }
      if (confirmAnswers.length === 0) {
        unhandled.push(entry);
        return rejected("FormScriptKit: openConfirmDialog was called but the test queued no answer");
      }
      return resolved(handOver({ confirmed: confirmAnswers.shift() }));
    },
    navigateTo(pageInput, navigationOptions) {
      const entry = record("Navigation.navigateTo", { pageInput, navigationOptions });
      const problem = checkNavigateTo(pageInput, navigationOptions);
      if (problem) return rejected(`FormScriptKit: ${problem}`);
      if (!navigateResponder) return unscripted(entry, `Navigation.navigateTo(${pageInput.pageType})`);
      return answer(navigateResponder, [toHost(pageInput), toHost(navigationOptions)], handOver);
    },
  };

  // Per the addGlobalNotification page: type is required and only 2 (a message
  // bar at the top of the app) is supported; level is 1 to 4. It resolves with
  // a GUID that identifies the notification.
  const App = {
    addGlobalNotification(notification) {
      record("App.addGlobalNotification", { notification });
      if (!isObject(notification)) return rejected("FormScriptKit: addGlobalNotification needs a notification object");
      if (notification.type !== 2) {
        return rejected(`FormScriptKit: notification.type must be 2, the only documented value; got ${show(notification.type)}`);
      }
      if (!NOTIFICATION_LEVELS.includes(notification.level)) {
        return rejected(`FormScriptKit: notification.level must be 1, 2, 3 or 4; got ${show(notification.level)}`);
      }
      if (typeof notification.message !== "string") {
        return rejected("FormScriptKit: notification.message must be a string");
      }
      const id = fakeGuid(nextCreatedId);
      nextCreatedId += 1;
      return resolved(id);
    },
  };

  const Utility = {
    showProgressIndicator(message) {
      record("Utility.showProgressIndicator", { message });
      progress.visible = true;
      progress.message = message === undefined ? null : toHost(message);
    },
    closeProgressIndicator() {
      record("Utility.closeProgressIndicator");
      progress.visible = false;
    },
    getGlobalContext() {
      const roleList = Array.from(roles, (role) => handOver({ id: role.id, name: role.name }));
      return {
        getClientUrl: () => clientUrl,
        userSettings: {
          userId,
          userName,
          languageId,
          roles: createCollection(() => roleList, { realm, nameOf: (role) => role.name }),
        },
      };
    },
  };

  const Xrm = { WebApi, Navigation, Utility, App };

  function requireResponder(responder, what) {
    if (typeof responder !== "function") throw new TypeError(`FormScriptKit: ${what} needs a responder function`);
  }

  return {
    Xrm,
    calls,
    unhandled,
    callsTo: (api) => calls.filter((call) => call.api === api),
    webApi: {
      /** Answers retrieveRecord, retrieveMultipleRecords, createRecord or updateRecord. */
      respond(method, responder) {
        if (!CRUD_METHODS.includes(method)) {
          throw new TypeError(`FormScriptKit: webApi.respond() takes one of ${CRUD_METHODS.join(", ")}; got ${show(method)}`);
        }
        requireResponder(responder, "webApi.respond()");
        crudResponders.set(method, responder);
      },
      /** Answers Xrm.WebApi.online.execute for one operationName. */
      respondToExecute(operationName, responder) {
        if (typeof operationName !== "string" || operationName === "") {
          throw new TypeError("FormScriptKit: webApi.respondToExecute() needs an operationName");
        }
        requireResponder(responder, "webApi.respondToExecute()");
        executeResponders.set(operationName, responder);
      },
    },
    navigation: {
      respondToAlert(responder) {
        requireResponder(responder, "navigation.respondToAlert()");
        alertResponder = responder;
      },
      /** Queues answers for openConfirmDialog, used in order. */
      answerConfirm(...answers) {
        if (answers.some((value) => typeof value !== "boolean")) {
          throw new TypeError("FormScriptKit: navigation.answerConfirm() takes booleans");
        }
        confirmAnswers.push(...answers);
      },
      respondToNavigateTo(responder) {
        requireResponder(responder, "navigation.respondToNavigateTo()");
        navigateResponder = responder;
      },
    },
    utility: {
      get progressVisible() {
        return progress.visible;
      },
      get progressMessage() {
        return progress.message;
      },
    },
  };
}

module.exports = { createXrm };
