"use strict";

const {
  HOST_REALM,
  copyInto,
  toHost,
  fakeGuid,
  bracedId,
  bareId,
  harnessError,
  isThenable,
  createCollection,
} = require("./realm");
const { createAttributeState, checkValue, sameValue } = require("./attributes");
const { SAVE_MODE, SAVE_IN_PROGRESS, SAVE_CANCELLED } = require("./constants");

// A form fixture. `fixture.formContext` is Xrm-shaped and carries only real
// Client API members; everything a test uses to drive or inspect the form
// (userEdit, userSave, saves, notifications, ...) lives on the fixture.

const FORM_TYPES = Object.freeze([0, 1, 2, 3, 4, 6]);
const NOTIFICATION_LEVELS = Object.freeze(["ERROR", "WARNING", "INFO"]);
const DISPLAY_STATES = Object.freeze(["expanded", "collapsed"]);
const ENTITY_SAVE_OPTIONS = Object.freeze({ saveandclose: SAVE_MODE.SAVE_AND_CLOSE, saveandnew: SAVE_MODE.SAVE_AND_NEW });
const FORM_OPTIONS = new Set([
  "entityName",
  "id",
  "formType",
  "primaryAttribute",
  "attributes",
  "tabs",
  "asyncSaveHandlers",
  "realm",
]);
const FIRST_CREATED_ID = 1001;

// Internal option, set by openForm: called after a create form's first save
// has committed and the save has ended, so the form can fire OnLoad again.
// A symbol key keeps it out of the public options that createForm checks.
const AFTER_CREATE = Symbol("FormScriptKit.afterCreate");

function show(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function requireBoolean(realm, what, value) {
  if (typeof value !== "boolean") throw harnessError(realm, `${what} takes true or false; got ${show(value)}`);
}

function createControl(controlName, attributeState, realm) {
  let label = attributeState.spec.label;
  let visible = attributeState.spec.visible;
  let disabled = attributeState.spec.disabled;
  const notifications = new Map();
  const controlType =
    attributeState.type === "lookup" ? "lookup" : attributeState.type === "optionset" ? "optionset" : "standard";

  const control = {
    getName: () => controlName,
    getControlType: () => controlType,
    getAttribute: () => attributeState.attribute,
    getLabel: () => label,
    setLabel(text) {
      if (typeof text !== "string") throw harnessError(realm, `${controlName}.setLabel() needs a string`);
      label = text;
    },
    getVisible: () => visible,
    setVisible(value) {
      requireBoolean(realm, `${controlName}.setVisible()`, value);
      visible = value;
    },
    getDisabled: () => disabled,
    setDisabled(value) {
      requireBoolean(realm, `${controlName}.setDisabled()`, value);
      disabled = value;
    },
    setNotification(message, uniqueId) {
      if (typeof message !== "string") throw harnessError(realm, `${controlName}.setNotification() needs a message string`);
      if (typeof uniqueId !== "string") throw harnessError(realm, `${controlName}.setNotification() needs a uniqueId string`);
      notifications.set(uniqueId, message);
      return true;
    },
    clearNotification(uniqueId) {
      if (uniqueId === undefined) notifications.clear();
      else notifications.delete(uniqueId);
      return true;
    },
  };
  return { control, notifications };
}

function createTabs(tabsSpec, realm) {
  const tabs = [];
  for (const [tabName, input] of Object.entries(tabsSpec)) {
    const spec = input || {};
    for (const key of Object.keys(spec)) {
      if (!["label", "visible", "displayState", "sections"].includes(key)) {
        throw new TypeError(`FormScriptKit: tab "${tabName}": unknown option "${key}"`);
      }
    }
    let label = spec.label === undefined ? tabName : spec.label;
    let visible = spec.visible === undefined ? true : spec.visible;
    let displayState = spec.displayState === undefined ? "expanded" : spec.displayState;
    if (typeof label !== "string") throw new TypeError(`FormScriptKit: tab "${tabName}": label must be a string`);
    if (typeof visible !== "boolean") throw new TypeError(`FormScriptKit: tab "${tabName}": visible must be a boolean`);
    if (!DISPLAY_STATES.includes(displayState)) {
      throw new TypeError(`FormScriptKit: tab "${tabName}": displayState must be "expanded" or "collapsed"`);
    }

    const sections = [];
    const tab = {
      getName: () => tabName,
      getLabel: () => label,
      setLabel(text) {
        if (typeof text !== "string") throw harnessError(realm, `tab ${tabName}.setLabel() needs a string`);
        label = text;
      },
      getVisible: () => visible,
      setVisible(value) {
        requireBoolean(realm, `tab ${tabName}.setVisible()`, value);
        visible = value;
      },
      getDisplayState: () => displayState,
      setDisplayState(state) {
        if (!DISPLAY_STATES.includes(state)) {
          throw harnessError(realm, `tab ${tabName}.setDisplayState() takes "expanded" or "collapsed"; got ${show(state)}`);
        }
        displayState = state;
      },
      sections: createCollection(() => sections, { realm }),
    };

    for (const [sectionName, sectionInput] of Object.entries(spec.sections || {})) {
      const sectionSpec = sectionInput || {};
      let sectionLabel = sectionSpec.label === undefined ? sectionName : sectionSpec.label;
      let sectionVisible = sectionSpec.visible === undefined ? true : sectionSpec.visible;
      if (typeof sectionVisible !== "boolean") {
        throw new TypeError(`FormScriptKit: section "${sectionName}": visible must be a boolean`);
      }
      sections.push({
        getName: () => sectionName,
        getLabel: () => sectionLabel,
        setLabel(text) {
          if (typeof text !== "string") throw harnessError(realm, `section ${sectionName}.setLabel() needs a string`);
          sectionLabel = text;
        },
        getVisible: () => sectionVisible,
        setVisible(value) {
          requireBoolean(realm, `section ${sectionName}.setVisible()`, value);
          sectionVisible = value;
        },
        getParent: () => tab,
      });
    }
    tabs.push(tab);
  }
  return tabs;
}

/**
 * Creates a form fixture. Options: entityName (required), id, formType,
 * primaryAttribute, attributes, tabs, asyncSaveHandlers, realm.
 */
function createForm(options = {}) {
  for (const key of Object.keys(options)) {
    if (!FORM_OPTIONS.has(key)) throw new TypeError(`FormScriptKit: createForm has no option "${key}"`);
  }
  const {
    entityName,
    id,
    formType,
    primaryAttribute = "name",
    attributes = {},
    tabs = {},
    asyncSaveHandlers = true,
    realm = null,
  } = options;
  const afterCreate = options[AFTER_CREATE] || null;

  if (typeof entityName !== "string" || entityName === "") {
    throw new TypeError('FormScriptKit: createForm needs an entityName such as "account"');
  }
  if (id !== undefined && id !== null && (typeof id !== "string" || bareId(id) === "")) {
    throw new TypeError("FormScriptKit: createForm id must be a GUID string (braces optional)");
  }
  let recordId = id ? bareId(id) : null;
  let currentFormType = formType === undefined ? (recordId ? 2 : 1) : formType;
  if (!FORM_TYPES.includes(currentFormType)) {
    throw new TypeError(`FormScriptKit: formType must be one of ${FORM_TYPES.join(", ")}; got ${show(formType)}`);
  }
  if (typeof asyncSaveHandlers !== "boolean") {
    throw new TypeError("FormScriptKit: asyncSaveHandlers must be true or false");
  }

  const handOver = (value) => copyInto(value, realm || HOST_REALM);
  const toSandboxPromise = (promise) =>
    realm ? new realm.Promise((resolve, reject) => promise.then(resolve, reject)) : promise;

  const saves = [];
  const saveAttempts = [];
  const refreshes = [];
  const scriptErrors = [];
  const formNotifications = new Map();
  const serverValues = new Map();
  let onSaveHandlers = [];
  let ribbonRefreshes = 0;
  let saving = false;
  let armedFailure = null;
  let nextCreatedId = FIRST_CREATED_ID;

  function recordError({ event, attribute, error }) {
    const entry = { event };
    if (attribute !== undefined) entry.attribute = attribute;
    entry.error = toHost(error);
    scriptErrors.push(entry);
  }

  let formContext = null;
  const env = { realm, getFormContext: () => formContext, recordError };

  const attributeStates = new Map();
  const controlStates = new Map();
  for (const [name, declaration] of Object.entries(attributes)) {
    const state = createAttributeState(name, declaration, env);
    attributeStates.set(name, state);
    for (const controlName of state.spec.controls) {
      if (controlStates.has(controlName)) {
        throw new TypeError(`FormScriptKit: control "${controlName}" is declared by two attributes`);
      }
      const control = createControl(controlName, state, realm);
      controlStates.set(controlName, control);
      state.controls.push(control.control);
    }
  }
  if (!attributeStates.has(primaryAttribute) && options.primaryAttribute !== undefined) {
    throw new TypeError(`FormScriptKit: primaryAttribute "${primaryAttribute}" is not among the attributes`);
  }
  const tabList = createTabs(tabs, realm);

  const anyDirty = () => Array.from(attributeStates.values()).some((state) => state.isDirty());

  function stateOf(name) {
    const state = attributeStates.get(name);
    if (!state) {
      const declared = Array.from(attributeStates.keys()).join(", ") || "none";
      throw new Error(`FormScriptKit: the form has no attribute "${name}" (declared: ${declared})`);
    }
    return state;
  }

  function startAttempt(saveMode, source) {
    const attempt = { saveMode, source, outcome: null, returnedPromise: false, latePreventDefault: false };
    saveAttempts.push(attempt);
    const finish = (outcome, error) => {
      attempt.outcome = outcome;
      if (error !== undefined) attempt.error = toHost(error);
      return { attempt, error: error === undefined ? null : error, created: false };
    };
    return { attempt, finish };
  }

  // The save pipeline. Steps up to the end of the handler loop run
  // synchronously, so a save started while handlers run sees `saving`. A
  // create form's first save hands over to `afterCreate` once it has ended,
  // and settles after it.
  async function runSave(saveMode, source) {
    const result = await saveSteps(saveMode, source);
    if (result.created && afterCreate) await afterCreate();
    return result;
  }

  async function saveSteps(saveMode, source) {
    const { attempt, finish } = startAttempt(saveMode, source);

    if (saving) return finish("busy", SAVE_IN_PROGRESS);
    saving = true;
    try {
      let prevented = false;
      let handlersRunning = true;
      const eventArgs = {
        preventDefault() {
          if (handlersRunning) prevented = true;
          else attempt.latePreventDefault = true;
        },
        isDefaultPrevented: () => prevented,
        getSaveMode: () => saveMode,
        disableAsyncTimeout() {},
      };
      const executionContext = {
        getFormContext: () => formContext,
        getEventArgs: () => eventArgs,
        getEventSource: () => formContext.data.entity,
      };

      const returned = [];
      for (const handler of onSaveHandlers.slice()) {
        try {
          const result = handler(executionContext);
          if (isThenable(result)) {
            attempt.returnedPromise = true;
            returned.push(result);
          }
        } catch (error) {
          recordError({ event: "onsave", error });
        }
      }
      handlersRunning = false;

      const settled = returned.map((promise) =>
        Promise.resolve(promise).then(
          () => undefined,
          (error) => recordError({ event: "onsave", error }),
        ),
      );
      if (asyncSaveHandlers && settled.length > 0) await Promise.all(settled);

      if (prevented) return finish("prevented", SAVE_CANCELLED);

      await null; // the simulated round trip; the save stays in progress across it

      if (armedFailure) {
        const { error } = armedFailure;
        armedFailure = null;
        return finish("failed", error);
      }

      const values = {};
      for (const state of attributeStates.values()) {
        const send = state.submitMode === "always" || (state.submitMode === "dirty" && state.isDirty());
        if (send) values[state.name] = toHost(state.value);
      }
      saves.push({ saveMode, source, values });
      for (const state of attributeStates.values()) state.commit();
      const result = finish("saved");
      if (!recordId) {
        recordId = fakeGuid(nextCreatedId);
        nextCreatedId += 1;
        currentFormType = 2;
        result.created = true;
      }
      return result;
    } finally {
      saving = false;
    }
  }

  async function reload(saveFirst) {
    if (saveFirst && anyDirty()) {
      const { error } = await runSave(SAVE_MODE.SAVE, "script");
      if (error) throw handOver(error);
    }
    await null; // the simulated round trip: nothing changes before refresh() has returned
    for (const state of attributeStates.values()) {
      const next = serverValues.has(state.name) ? serverValues.get(state.name) : state.baseline;
      state.value = handOver(next);
      state.commit();
    }
    serverValues.clear();
    refreshes.push({ save: saveFirst });
  }

  const attributeCollection = createCollection(
    () => Array.from(attributeStates.values(), (state) => state.attribute),
    { realm },
  );
  const controlCollection = createCollection(() => Array.from(controlStates.values(), (entry) => entry.control), {
    realm,
  });

  const entity = {
    getId: () => (recordId ? bracedId(recordId) : ""),
    getEntityName: () => entityName,
    getPrimaryAttributeValue() {
      const state = attributeStates.get(primaryAttribute);
      return state && state.value !== null && state.value !== undefined ? state.value : "";
    },
    getEntityReference() {
      return handOver({ entityType: entityName, id: entity.getId(), name: entity.getPrimaryAttributeValue() });
    },
    getIsDirty: () => anyDirty(),
    addOnSave(handler) {
      if (typeof handler !== "function") throw harnessError(realm, "addOnSave() needs a function");
      onSaveHandlers.push(handler);
    },
    removeOnSave(handler) {
      onSaveHandlers = onSaveHandlers.filter((registered) => registered !== handler);
    },
    save(saveOption) {
      let saveMode;
      if (saveOption === undefined) saveMode = SAVE_MODE.SAVE;
      else if (typeof saveOption === "string" && Object.hasOwn(ENTITY_SAVE_OPTIONS, saveOption)) {
        saveMode = ENTITY_SAVE_OPTIONS[saveOption];
      } else {
        throw harnessError(realm, `entity.save() takes nothing, "saveandclose" or "saveandnew"; got ${show(saveOption)}`);
      }
      runSave(saveMode, "script");
      return undefined;
    },
  };

  formContext = {
    data: {
      entity,
      getIsDirty: () => anyDirty(),
      save(saveOptions) {
        if (saveOptions !== undefined && (saveOptions === null || typeof saveOptions !== "object")) {
          throw harnessError(realm, "data.save() takes nothing or a saveOptions object");
        }
        const saveMode =
          saveOptions === undefined || saveOptions.saveMode === undefined ? SAVE_MODE.SAVE : saveOptions.saveMode;
        if (typeof saveMode !== "number") throw harnessError(realm, "data.save() saveOptions.saveMode must be a number");
        if (!anyDirty()) {
          // OnSave fires for data.save() only when there is unsaved data.
          startAttempt(saveMode, "script").finish("clean");
          return toSandboxPromise(Promise.resolve(undefined));
        }
        return toSandboxPromise(
          runSave(saveMode, "script").then(({ error }) => {
            if (error) throw handOver(error);
            return undefined;
          }),
        );
      },
      refresh(save) {
        if (save !== undefined && typeof save !== "boolean") {
          throw harnessError(realm, "data.refresh() takes true, false or nothing");
        }
        return toSandboxPromise(reload(save === true));
      },
    },
    ui: {
      getFormType: () => currentFormType,
      setFormNotification(message, level, uniqueId) {
        if (typeof message !== "string") throw harnessError(realm, "setFormNotification() needs the message as a string");
        if (!NOTIFICATION_LEVELS.includes(level)) {
          throw harnessError(realm, `setFormNotification() level must be ERROR, WARNING or INFO; got ${show(level)}`);
        }
        if (typeof uniqueId !== "string") throw harnessError(realm, "setFormNotification() needs a uniqueId string");
        const shown = Object.freeze({ level, message });
        formNotifications.set(uniqueId, shown);
        return true;
      },
      clearFormNotification(uniqueId) {
        const wasShown = formNotifications.has(uniqueId);
        if (wasShown) formNotifications.delete(uniqueId);
        return wasShown;
      },
      refreshRibbon() {
        ribbonRefreshes += 1;
      },
      tabs: createCollection(() => tabList, { realm }),
    },
    getAttribute: (arg) => attributeCollection.get(arg),
    getControl: (arg) => controlCollection.get(arg),
  };

  const fixture = {
    formContext,
    saves,
    saveAttempts,
    refreshes,
    scriptErrors,

    /** Like getAttribute(name), but throws when the attribute isn't declared. */
    attribute: (name) => stateOf(name).attribute,
    /** A host copy of the attribute's current value. */
    value: (name) => toHost(stateOf(name).value),
    /** What a user typing does: setValue, then OnChange if the value changed. */
    userEdit(name, value) {
      const state = stateOf(name);
      const before = state.value;
      state.assign(value);
      if (!sameValue(state.type, before, state.value)) state.fireOnChange();
    },
    /** A save started by the user. Resolves with the attempt record; never rejects. */
    userSave(saveMode = SAVE_MODE.SAVE) {
      if (typeof saveMode !== "number") throw new TypeError("FormScriptKit: userSave() takes a numeric save mode");
      return runSave(saveMode, "user").then(({ attempt }) => attempt);
    },
    /** An execution context for calling a handler directly. */
    executionContext() {
      return { getFormContext: () => formContext, getEventArgs: () => null, getEventSource: () => formContext };
    },
    get ribbonRefreshes() {
      return ribbonRefreshes;
    },
    get isSaving() {
      return saving;
    },
    get formNotifications() {
      const notifications = {};
      for (const [uniqueId, entry] of formNotifications) {
        notifications[uniqueId] = { message: entry.message, level: entry.level };
      }
      return notifications;
    },
    controlNotifications(controlName) {
      const entry = controlStates.get(controlName);
      if (!entry) throw new Error(`FormScriptKit: the form has no control "${controlName}"`);
      return Object.fromEntries(entry.notifications);
    },
    /** The next save that reaches the server fails with `error`. */
    failNextSave(error) {
      if (error === undefined) throw new TypeError("FormScriptKit: failNextSave() needs the error to reject with");
      armedFailure = { error: toHost(error) };
    },
    /** Values the next refresh() loads, as if another user had saved them. */
    setServerValues(values) {
      for (const [name, value] of Object.entries(values)) {
        const state = stateOf(name);
        const problem = checkValue(state.spec, value);
        if (problem) throw new TypeError(`FormScriptKit: server value for ${name} ${problem}`);
        serverValues.set(name, toHost(value));
      }
    },
  };
  return fixture;
}

module.exports = { createForm, FORM_TYPES, NOTIFICATION_LEVELS, AFTER_CREATE };
