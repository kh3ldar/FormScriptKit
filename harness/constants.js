"use strict";

/**
 * Save modes passed to OnSave handlers through getSaveMode(), as Microsoft
 * documents them for model-driven apps.
 */
const SAVE_MODE = Object.freeze({
  SAVE: 1,
  SAVE_AND_CLOSE: 2,
  DEACTIVATE: 5,
  REACTIVATE: 6,
  SEND: 7,
  DISQUALIFY: 15,
  QUALIFY: 16,
  ASSIGN: 47,
  SAVE_AS_COMPLETED: 58,
  SAVE_AND_NEW: 59,
  AUTOSAVE: 70,
});

/** Values returned by formContext.ui.getFormType(), as Microsoft documents them. */
const FORM_TYPE = Object.freeze({
  UNDEFINED: 0,
  CREATE: 1,
  UPDATE: 2,
  READ_ONLY: 3,
  DISABLED: 4,
  BULK_EDIT: 6,
});

/**
 * Values the OnLoad event args return from getDataLoadState(), as Microsoft
 * documents them. The harness fires OnLoad with INITIAL from fireOnLoad() and
 * with SAVE after a create form's first save; it never fires REFRESH.
 */
const LOAD_STATE = Object.freeze({
  INITIAL: 1,
  SAVE: 2,
  REFRESH: 3,
});

/**
 * What a save started while another save is still in progress rejects with.
 *
 * Not from Microsoft's documentation, which doesn't describe this case. This
 * code and message are what a production Unified Interface form returned when
 * an OnSave handler started a save while the save that called it was still
 * open. The fake reproduces the observation; code under test should not
 * depend on the exact number.
 */
const SAVE_IN_PROGRESS = Object.freeze({
  errorCode: 2200000003,
  message: "Please wait while saving is completed",
});

/**
 * What a script-started save rejects with when an OnSave handler cancelled it.
 * Microsoft doesn't document this value, so it is the harness's own choice
 * and code under test must not depend on its shape.
 */
const SAVE_CANCELLED = Object.freeze({
  errorCode: null,
  message: "FormScriptKit: the save was cancelled by an OnSave handler.",
});

module.exports = { SAVE_MODE, FORM_TYPE, LOAD_STATE, SAVE_IN_PROGRESS, SAVE_CANCELLED };
