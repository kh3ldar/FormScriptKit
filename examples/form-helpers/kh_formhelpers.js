/*
 * kh_formhelpers.js (Script web resource): five small helpers a form script
 * library tends to grow, written as one namespace so a form can load it once.
 *
 *   safeHandler / wireOnChange   an error boundary around event handlers
 *   withProgress                 a progress indicator that always closes
 *   confirm / confirmThenProgress  wait for a confirm dialog to leave the screen
 *   hasAnyRole                   a role check that reads the roles once
 *   runRibbonAction              save if dirty, progress, Custom API, message, refresh
 *
 * Nothing here is bound to a table. The ribbon runner takes the Custom API's
 * name and parameters from its caller.
 */
var KhFormHelpers = (function () {
  "use strict";

  var ERROR_ID_PREFIX = "kh_handler_error_";
  var CONFIRM_SETTLE_MS = 150;
  var LEVEL = { SUCCESS: 1, ERROR: 2 }; // Xrm.App.addGlobalNotification levels

  var MSG_HANDLER_FAILED = "Something went wrong in ";
  var MSG_SAVE_FAILED = "The record couldn't be saved, so the action wasn't run.";
  var MSG_ACTION_FAILED = "The action failed.";

  function messageOf(error) {
    if (typeof error === "string") {
      return error;
    }
    return error && error.message ? String(error.message) : "";
  }

  function isThenable(value) {
    return value !== null && typeof value === "object" && typeof value.then === "function";
  }

  // ---- 1. Error-safe event wiring -----------------------------------------

  // Wraps an event handler so a failure becomes a form notification and a
  // console entry instead of an exception in the event pipeline. The
  // notification id is per handler name, so a repeated failure replaces its
  // own message and a later success clears it. Async handlers are covered too.
  function safeHandler(name, handler) {
    return function (executionContext) {
      var formContext = executionContext && executionContext.getFormContext();

      function succeeded() {
        if (formContext) {
          formContext.ui.clearFormNotification(ERROR_ID_PREFIX + name);
        }
      }

      function failed(error) {
        console.error("[kh] handler " + name + " failed:", error);
        if (formContext) {
          var detail = messageOf(error);
          formContext.ui.setFormNotification(
            MSG_HANDLER_FAILED + name + (detail ? ": " + detail : "."),
            "ERROR",
            ERROR_ID_PREFIX + name
          );
        }
      }

      try {
        var result = handler(executionContext);
        if (isThenable(result)) {
          return result.then(succeeded, failed);
        }
        succeeded();
        return undefined;
      } catch (error) {
        failed(error);
        return undefined;
      }
    };
  }

  // Adds one safe OnChange handler per attribute. Returns { unwire() }. An
  // attribute that isn't on the form is skipped with a warning: a form that
  // lost a column shouldn't lose every other handler.
  function wireOnChange(formContext, handlersByAttribute) {
    var wired = [];
    Object.keys(handlersByAttribute).forEach(function (attributeName) {
      var attribute = formContext.getAttribute(attributeName);
      if (!attribute) {
        console.warn("[kh] attribute " + attributeName + " isn't on the form; its handler wasn't added.");
        return;
      }
      var wrapped = safeHandler(attributeName, handlersByAttribute[attributeName]);
      attribute.addOnChange(wrapped);
      wired.push({ attribute: attribute, handler: wrapped });
    });
    return {
      unwire: function () {
        wired.forEach(function (entry) {
          entry.attribute.removeOnChange(entry.handler);
        });
        wired = [];
      }
    };
  }

  // ---- 2. A progress indicator that always closes -------------------------

  async function withProgress(message, work) {
    Xrm.Utility.showProgressIndicator(message);
    try {
      return await work();
    } finally {
      Xrm.Utility.closeProgressIndicator();
    }
  }

  // ---- 3. Confirm, then progress ------------------------------------------

  // Resolves once `frames` animation frames have been painted and then
  // `floorMs` has passed on the timer. Without requestAnimationFrame only the
  // timer counts. A hidden tab pauses animation frames, so there the wait
  // carries on when the tab is shown again.
  function afterPaint(frames, floorMs) {
    return new Promise(function (resolve) {
      var paint = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
      (function step(left) {
        if (paint && left > 0) {
          paint(function () {
            step(left - 1);
          });
        } else {
          setTimeout(resolve, floorMs);
        }
      })(frames);
    });
  }

  // Resolves true or false once the confirm dialog has had time to leave the
  // screen. The author saw a progress indicator shown straight after the
  // confirm resolved leave the dialog stuck on screen; Microsoft doesn't
  // document that, so the wait is a defence, not a documented requirement.
  async function confirm(strings, options) {
    var answer = await Xrm.Navigation.openConfirmDialog(strings, options);
    await afterPaint(2, CONFIRM_SETTLE_MS);
    return answer ? answer.confirmed === true : false;
  }

  // Confirms, and only on yes runs `work` under a progress indicator.
  // Resolves { confirmed: false } on no, otherwise { confirmed: true, result }.
  async function confirmThenProgress(strings, progressMessage, work) {
    if (!(await confirm(strings))) {
      return { confirmed: false };
    }
    var result = await withProgress(progressMessage, work);
    return { confirmed: true, result: result };
  }

  // ---- 4. A memoised role check -------------------------------------------

  var roleNames = null;

  // The roles are read on the first call and kept for the life of the page.
  // A failed read isn't kept: that call answers as if the user had no roles,
  // and the next call reads again.
  function currentRoleNames() {
    if (roleNames !== null) {
      return roleNames;
    }
    try {
      var names = [];
      Xrm.Utility.getGlobalContext().userSettings.roles.forEach(function (role) {
        var name = role && role.name ? String(role.name).toLowerCase() : "";
        if (name !== "" && names.indexOf(name) === -1) {
          names.push(name);
        }
      });
      roleNames = names;
      return roleNames;
    } catch (error) {
      return [];
    }
  }

  function hasAnyRole(wanted) {
    var have = currentRoleNames();
    return wanted.some(function (name) {
      return have.indexOf(String(name).toLowerCase()) !== -1;
    });
  }

  // ---- 5. A ribbon action runner ------------------------------------------

  // A message bar at the top of the app. One that can't be shown is logged,
  // and the caller carries on.
  async function notify(text, level) {
    try {
      await Xrm.App.addGlobalNotification({
        type: 2,
        level: level,
        message: text,
        showCloseButton: true
      });
    } catch (error) {
      console.warn("[kh] the notification couldn't be shown:", error);
    }
  }

  // Resolves false only when there were unsaved changes and the save failed.
  function savePending(formContext) {
    if (!formContext.data.entity.getIsDirty()) {
      return Promise.resolve(true);
    }
    return formContext.data.save().then(
      function () {
        return true;
      },
      function () {
        return false;
      }
    );
  }

  // An unbound action request: primitive parameters from { Name: { type,
  // value } }, getMetadata on the prototype as Microsoft's execute page asks.
  // An Edm.Guid value is sent as { guid: value }, the shape the client's
  // serializer reads (the README says where that comes from).
  function buildRequest(operationName, parameters) {
    var parameterTypes = {};
    function UnboundActionRequest() {
      var request = this;
      Object.keys(parameters).forEach(function (name) {
        var parameter = parameters[name];
        request[name] = parameter.type === "Edm.Guid" ? { guid: parameter.value } : parameter.value;
        parameterTypes[name] = { typeName: parameter.type, structuralProperty: 1 };
      });
    }
    UnboundActionRequest.prototype.getMetadata = function () {
      return { boundParameter: null, operationType: 0, operationName: operationName, parameterTypes: parameterTypes };
    };
    return new UnboundActionRequest();
  }

  // execute() can resolve with a response whose `ok` is false. Turn that into
  // a rejection that carries the server's message when the body has one.
  function refuseUnlessOk(response) {
    if (!response || response.ok !== false) {
      return response;
    }
    var fallback = new Error("HTTP " + response.status + " " + response.statusText);
    return response.json().then(
      function (body) {
        throw body && body.error && body.error.message ? new Error(body.error.message) : fallback;
      },
      function () {
        throw fallback;
      }
    );
  }

  // The command behind a ribbon button that calls an unbound Custom API:
  // save if dirty, then under a progress indicator call the API, then a
  // message and a refresh. Resolves { ok: true, result } or
  // { ok: false, stage, error? }, so a command bar caller has nothing to catch.
  //
  // config: formContext, operationName, parameters(formContext) returning
  // { Name: { type: "Edm.Guid", value } }, progressMessage, successMessage.
  // A refusal from the API is shown with the server's own sentence.
  async function runRibbonAction(config) {
    var formContext = config.formContext;
    if (!(await savePending(formContext))) {
      await notify(MSG_SAVE_FAILED, LEVEL.ERROR);
      return { ok: false, stage: "save" };
    }

    var result;
    try {
      var request = buildRequest(config.operationName, config.parameters(formContext));
      result = await withProgress(config.progressMessage, function () {
        return Xrm.WebApi.online.execute(request).then(refuseUnlessOk);
      });
    } catch (error) {
      await notify(messageOf(error) || MSG_ACTION_FAILED, LEVEL.ERROR);
      return { ok: false, stage: "action", error: error };
    }

    // The success message is shown before the refresh, so it doesn't depend
    // on anything that runs after the form reloads.
    await notify(config.successMessage, LEVEL.SUCCESS);
    try {
      await formContext.data.refresh(false);
      formContext.ui.refreshRibbon(true);
    } catch (error) {
      console.warn("[kh] refresh after the action failed:", error);
    }
    return { ok: true, result: result };
  }

  return {
    safeHandler: safeHandler,
    wireOnChange: wireOnChange,
    withProgress: withProgress,
    confirm: confirm,
    confirmThenProgress: confirmThenProgress,
    hasAnyRole: hasAnyRole,
    runRibbonAction: runRibbonAction
  };
})();
