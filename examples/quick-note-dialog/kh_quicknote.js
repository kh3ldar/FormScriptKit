/*
 * kh_quicknote.js (Script web resource): the "Quick note" command on the
 * opportunity main form. The command calls KhQuickNote.open with two
 * parameters: PrimaryControl and the table's entity set name as a string
 * (for example "opportunities").
 *
 * It opens kh_quicknotedialog.html as a centred dialog and creates the note
 * the user writes there as an annotation regarding the open record.
 *
 * Data in: navigateTo passes pageInput.data to the page as its `data`
 * query-string parameter: JSON with a one-time resultKey and the record name.
 * Result out: an HTML web resource dialog returns no value, so the page
 * stores its result in sessionStorage under resultKey (both frames are served
 * from the org URL and share the tab's sessionStorage). The opener reads and
 * removes that entry after navigateTo resolves, which happens when the dialog
 * closes, however it was closed. Nothing is passed through window.top.
 */
var KhQuickNote = (function () {
  "use strict";

  var DIALOG_NAME = "kh_quicknotedialog.html";
  var KEY_PREFIX = "kh_quicknote_";
  var NOTIFICATION_ID = "kh_quicknote";

  var MSG_CONFIG = "This command needs the table's entity set name as its second parameter.";
  var MSG_UNSAVED = "Save the record before adding a note.";
  var MSG_OPEN_FAILED = "The note dialog couldn't be opened: ";
  var MSG_CREATED = "Note added.";
  var MSG_CREATE_FAILED = "The note wasn't saved: ";

  function withoutBraces(id) {
    return String(id).replace(/[{}]/g, "").toLowerCase();
  }

  function messageOf(error) {
    return error && error.message ? String(error.message) : "";
  }

  function alertUser(text) {
    return Xrm.Navigation.openAlertDialog({ text: text }).then(null, function () {
      return undefined;
    });
  }

  // A sessionStorage call that treats blocked storage as "nothing there".
  function storageCall(method, key) {
    try {
      return sessionStorage[method](key);
    } catch (blocked) {
      return null;
    }
  }

  // Reads the dialog's answer once. The entry is removed whatever was read,
  // so nothing outlives this call.
  function takeResult(resultKey) {
    var raw = storageCall("getItem", resultKey);
    storageCall("removeItem", resultKey);
    return typeof raw === "string" ? raw : null;
  }

  // A key no earlier dialog can have used: the clock in milliseconds plus a
  // random hexadecimal suffix.
  function oneTimeKey() {
    var suffix = Math.floor(Math.random() * 0x100000000).toString(16);
    return KEY_PREFIX + Date.now() + "-" + suffix;
  }

  function parseResult(raw) {
    if (typeof raw !== "string") {
      return null;
    }
    try {
      var result = JSON.parse(raw);
      return result !== null && typeof result === "object" ? result : null;
    } catch (error) {
      return null;
    }
  }

  async function open(primaryControl, entitySetName) {
    var formContext = primaryControl;
    var ui = formContext.ui;
    var entity = formContext.data.entity;
    ui.clearFormNotification(NOTIFICATION_ID);

    if (typeof entitySetName !== "string" || entitySetName === "") {
      await alertUser(MSG_CONFIG);
      return null;
    }
    var recordId = entity.getId();
    if (!recordId) {
      await alertUser(MSG_UNSAVED);
      return null;
    }

    var resultKey = oneTimeKey();
    var recordName = String(entity.getPrimaryAttributeValue() || "").replace(/[<>]/g, "");

    var openError = null;
    try {
      await Xrm.Navigation.navigateTo(
        {
          pageType: "webresource",
          webresourceName: DIALOG_NAME,
          data: JSON.stringify({ resultKey: resultKey, recordName: recordName })
        },
        {
          target: 2,
          position: 1,
          width: { value: 480, unit: "px" },
          height: { value: 380, unit: "px" },
          title: "Quick note"
        }
      );
    } catch (error) {
      openError = error;
    }
    var raw = takeResult(resultKey);

    if (openError) {
      ui.setFormNotification(MSG_OPEN_FAILED + messageOf(openError), "ERROR", NOTIFICATION_ID);
      return null;
    }

    var result = parseResult(raw);
    if (!result || result.confirmed !== true || typeof result.text !== "string") {
      return null;
    }
    var text = result.text.trim();
    var title = typeof result.title === "string" ? result.title.trim() : "";
    if (text === "") {
      return null;
    }

    var note = { notetext: text };
    if (title !== "") {
      note.subject = title;
    }
    note["objectid_" + entity.getEntityName() + "@odata.bind"] =
      "/" + entitySetName + "(" + withoutBraces(recordId) + ")";

    try {
      var created = await Xrm.WebApi.createRecord("annotation", note);
      ui.setFormNotification(MSG_CREATED, "INFO", NOTIFICATION_ID);
      return created.id;
    } catch (error) {
      ui.setFormNotification(MSG_CREATE_FAILED + messageOf(error), "ERROR", NOTIFICATION_ID);
      return null;
    }
  }

  return { open: open };
})();
