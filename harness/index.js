"use strict";

// FormScriptKit harness: the one module tests require.

const { createSandbox, loadWebResources } = require("./sandbox");
const { createForm } = require("./form");
const { createXrm } = require("./xrm");
const { openForm } = require("./open-form");
const { createTimers } = require("./timers");
const { createStorage } = require("./storage");
const { createConsole } = require("./console");
const { extractScripts, openHtmlWebResource } = require("./html");
const realm = require("./realm");
const constants = require("./constants");

module.exports = {
  /**
   * Creates an empty sandbox standing for one form's script frame: a vm
   * context whose global is `window` (also `self`, `top`, `parent`).
   * @param {{ globals?: object, root?: string, timers?: object, console?: "capture" | object,
   *   sessionStorage?: object, localStorage?: object }} [options]
   * @returns {{ load(...paths: string[]): object, run(code: string, filename?: string): any,
   *   define(name: string, value: any): object, get(expression: string): any,
   *   fn(dottedName: string): Function, context: object, global: object, realm: object,
   *   timers: object, console: object, logs: object[] | null, sessionStorage: object,
   *   localStorage: object, files: string[] }}
   */
  createSandbox,

  /**
   * createSandbox(options).load(...files): loads web resources unchanged, in order, into one sandbox.
   * @param {string | string[]} files
   * @param {object} [options] the createSandbox options
   */
  loadWebResources,

  /**
   * Creates a form fixture whose `formContext` carries only real Client API
   * members; test-only members (userEdit, userSave, saves, ...) sit on the fixture.
   * @param {{ entityName: string, id?: string, formType?: number, primaryAttribute?: string,
   *   attributes?: object, tabs?: object, asyncSaveHandlers?: boolean, realm?: object }} options
   */
  createForm,

  /**
   * Creates an Xrm fixture: `fixture.Xrm` is the object to inject as the global
   * Xrm; responders, recorded calls and progress state sit on the fixture.
   * @param {{ globalContext?: { clientUrl?: string, userId?: string, userName?: string,
   *   languageId?: number, roles?: Array<{ id: string, name: string }> }, realm?: object }} [options]
   */
  createXrm,

  /**
   * Opens a form the way the platform does: loads the libraries into one
   * sandbox, injects Xrm, binds handlers by dotted name (failing fast on a bad
   * name), fires OnLoad again after a create form's first save, and returns
   * { sandbox, form, xrm, timers, loads, fireOnLoad(), settle(), call() }.
   * @param {object} options libraries (required), root, the createForm options, xrm,
   *   globals, sessionStorage, localStorage, console, handlers { onLoad, onSave, onChange },
   *   onLoadAfterCreate (default true)
   */
  openForm,

  /**
   * Deterministic timers: setTimeout/setInterval and their clears, plus
   * now, pending, next(), advance(ms), runAll(), flush() and settle().
   */
  createTimers,

  /** An in-memory Web Storage with test-only `blocked` and `snapshot()`. */
  createStorage,

  /** A console that records { level, args } entries instead of printing. */
  createConsole,

  /**
   * Finds the <script> blocks of an HTML document outside comments.
   * @param {string} html
   * @returns {Array<{ code: string, src: string | null, type: string | null, line: number }>}
   */
  extractScripts,

  /**
   * Runs an HTML web resource's scripts against a fake DOM built from its markup.
   * @param {string} file
   * @param {{ data?: string, search?: string, sessionStorage?: object, localStorage?: object,
   *   host?: object, console?: "capture" | object, scripts?: Record<string, string> }} [options]
   */
  openHtmlWebResource,

  /** Deep copy into the test's realm, so assert.deepStrictEqual works on sandbox values. */
  toHost: realm.toHost,

  /** Deep copy into the given realm (for example sandbox.realm). */
  copyInto: realm.copyInto,

  /** A GUID built at runtime from an integer: fakeGuid(42) ends in ...00000000002a. */
  fakeGuid: realm.fakeGuid,

  /** "{" + upper-case GUID + "}". */
  bracedId: realm.bracedId,

  /** Strips braces and lowercases. */
  bareId: realm.bareId,

  /** { promise, resolve, reject }, for responders a test settles by hand. */
  deferred: realm.deferred,

  /** { errorCode, message }, the shape Client API error callbacks receive. */
  xrmError: realm.xrmError,

  /** An explicit execute() response: xrmResponse(body, { status, statusText }). */
  xrmResponse: realm.xrmResponse,

  /** Save modes OnSave handlers see through getSaveMode(). */
  SAVE_MODE: constants.SAVE_MODE,

  /** Values formContext.ui.getFormType() returns. */
  FORM_TYPE: constants.FORM_TYPE,

  /** Values the OnLoad event args return from getDataLoadState(). */
  LOAD_STATE: constants.LOAD_STATE,

  /** What a save started during another save rejects with (an observed value, not documented). */
  SAVE_IN_PROGRESS: constants.SAVE_IN_PROGRESS,

  /** What a script save cancelled by an OnSave handler rejects with (the harness's choice). */
  SAVE_CANCELLED: constants.SAVE_CANCELLED,
};
