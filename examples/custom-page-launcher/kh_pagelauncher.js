/*
 * kh_pagelauncher.js (Script web resource): the "Edit lines" command on the
 * quote main form. The command calls KhPageLauncher.openLineEditor with one
 * parameter: PrimaryControl.
 *
 * It opens a Custom Page as a centred dialog, sized for the quote's lines,
 * and picks up what the page says when it closes.
 *
 * Two constraints shape it.
 *
 * 1. navigateTo takes the dialog's size when it opens, and the Client API has
 *    no call to change it afterwards. So the height is worked out first, from
 *    the number of lines, and capped by the window. If the lines can't be
 *    counted, a fixed height is used.
 * 2. navigateTo carries no result back from a Custom Page: it resolves when
 *    the dialog closes, and that is all it is used for. The page hands its
 *    result back through localStorage under a per-record key, as JSON
 *    { at, saved, message? }, where `at` is Date.now() when it wrote the
 *    entry. The launcher reads and removes the entry when the dialog closes.
 *    An entry whose page never got to close cleanly would stay behind, so
 *    every launch first removes this launcher's keys older than an hour.
 *
 * The form must be saved first: the launcher refreshes it after the page has
 * saved, and unsaved edits shouldn't meet that refresh.
 *
 * The Custom Page itself isn't part of this repo. Its contract is the
 * parameters in pageInput (name, entityName, recordId) and the key above.
 */
var KhPageLauncher = (function () {
  "use strict";

  var PAGE_NAME = "kh_quotelineeditor_1a2b3";
  var KEY_PREFIX = "kh_pagelauncher_result_";
  var EXPIRY_MS = 60 * 60 * 1000;
  var NOTIFICATION_ID = "kh_pagelauncher";

  // The page is a fixed frame (title bar, column headings, totals, buttons)
  // around one grid row per line. The dialog takes what the lines need, never
  // less than SHORTEST_PX and never more than WINDOW_SHARE of the window.
  var FRAME_PX = 250;
  var LINE_PX = 40;
  var SHORTEST_PX = 380;
  var WINDOW_SHARE = 0.8;
  var ASSUMED_WINDOW_PX = 800; // when window.innerHeight isn't a number
  var UNCOUNTED_PX = 540; // when the lines can't be counted

  var MSG_UNSAVED = "Save the quote before editing its lines.";
  var MSG_OPEN_FAILED = "The line editor couldn't be opened: ";
  var MSG_REFRESH_FAILED = "The lines were saved, but the form couldn't be refreshed.";

  function withoutBraces(id) {
    return String(id).replace(/[{}]/g, "").toLowerCase();
  }

  function messageOf(error) {
    return error && error.message ? String(error.message) : "";
  }

  // ---- localStorage, where blocked storage means "nothing there" ----------

  function storage(call) {
    try {
      return call(window.localStorage);
    } catch (blocked) {
      return null;
    }
  }

  // Removes this launcher's entries older than EXPIRY_MS, and any that can't
  // be read as a result. Keys are collected first: removing while walking
  // localStorage by index would skip entries.
  function removeExpiredEntries() {
    storage(function (store) {
      var now = Date.now();
      var stale = [];
      for (var i = 0; i < store.length; i++) {
        var key = store.key(i);
        if (key === null || key.indexOf(KEY_PREFIX) !== 0) {
          continue;
        }
        var entry = parseEntry(store.getItem(key));
        if (entry === null || typeof entry.at !== "number" || now - entry.at > EXPIRY_MS) {
          stale.push(key);
        }
      }
      stale.forEach(function (key) {
        store.removeItem(key);
      });
    });
  }

  function parseEntry(raw) {
    if (typeof raw !== "string") {
      return null;
    }
    try {
      var value = JSON.parse(raw);
      return value !== null && typeof value === "object" ? value : null;
    } catch (error) {
      return null;
    }
  }

  function takeResult(key) {
    var raw = storage(function (store) {
      return store.getItem(key);
    });
    storage(function (store) {
      store.removeItem(key);
    });
    return parseEntry(raw);
  }

  // ---- sizing --------------------------------------------------------------

  function tallest(windowHeight) {
    var available = typeof windowHeight === "number" && windowHeight > 0 ? windowHeight : ASSUMED_WINDOW_PX;
    return Math.floor(available * WINDOW_SHARE);
  }

  // Pure: the dialog height in pixels for `lineCount` lines, in a window
  // `windowHeight` pixels tall. A window too short for SHORTEST_PX wins.
  function dialogHeight(lineCount, windowHeight) {
    var needed = Math.max(SHORTEST_PX, FRAME_PX + lineCount * LINE_PX);
    return Math.min(needed, tallest(windowHeight));
  }

  // From this many lines on, the dialog is as tall as the window allows, so
  // the count asks for no more rows than that.
  function linesWorthCounting(windowHeight) {
    return Math.max(1, Math.ceil((tallest(windowHeight) - FRAME_PX) / LINE_PX));
  }

  async function heightFor(quoteId) {
    var windowHeight = window.innerHeight;
    try {
      var lines = await Xrm.WebApi.retrieveMultipleRecords(
        "quotedetail",
        "?$select=quotedetailid&$filter=_quoteid_value eq " + quoteId + "&$top=" + linesWorthCounting(windowHeight)
      );
      return dialogHeight(lines.entities.length, windowHeight);
    } catch (error) {
      return Math.min(UNCOUNTED_PX, tallest(windowHeight)); // the count is only a size hint
    }
  }

  // ---- the command ---------------------------------------------------------

  async function openLineEditor(primaryControl) {
    var formContext = primaryControl;
    var ui = formContext.ui;
    var entity = formContext.data.entity;
    ui.clearFormNotification(NOTIFICATION_ID);
    removeExpiredEntries();

    if (!entity.getId() || entity.getIsDirty()) {
      await Xrm.Navigation.openAlertDialog({ text: MSG_UNSAVED }).then(null, function () {
        return undefined;
      });
      return null;
    }
    var recordId = withoutBraces(entity.getId());
    var resultKey = KEY_PREFIX + recordId;
    storage(function (store) {
      store.removeItem(resultKey); // nothing left over from an earlier open
    });

    var height = await heightFor(recordId);
    try {
      await Xrm.Navigation.navigateTo(
        { pageType: "custom", name: PAGE_NAME, entityName: entity.getEntityName(), recordId: recordId },
        {
          target: 2,
          position: 1,
          width: { value: 50, unit: "%" },
          height: { value: height, unit: "px" },
          title: "Edit lines"
        }
      );
    } catch (error) {
      ui.setFormNotification(MSG_OPEN_FAILED + messageOf(error), "ERROR", NOTIFICATION_ID);
      return null;
    }

    var result = takeResult(resultKey);
    if (result === null || result.saved !== true) {
      return result;
    }
    try {
      await formContext.data.refresh(false);
    } catch (error) {
      ui.setFormNotification(MSG_REFRESH_FAILED, "WARNING", NOTIFICATION_ID);
      return result;
    }
    if (typeof result.message === "string" && result.message !== "") {
      ui.setFormNotification(result.message, "INFO", NOTIFICATION_ID);
    }
    return result;
  }

  return { openLineEditor: openLineEditor, dialogHeight: dialogHeight };
})();
