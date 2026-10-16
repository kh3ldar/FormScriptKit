/*
 * kh_quotediscount.js (Script web resource) for the quote main form.
 * Register KhQuoteDiscount.onLoad on the form's OnLoad event with
 * "Pass execution context as first parameter"; it adds its own OnSave handler.
 *
 * Before a changed Quote Discount (%) is saved, the unbound Custom API
 * kh_RecalculateQuoteDiscount says how much discount the quote may carry.
 * If it allows less than the user typed, the user decides before anything
 * is saved.
 *
 * Custom API (unbound action):
 *   request   QuoteId (Edm.Guid), DiscountPercentage (Edm.Decimal)
 *   response  AppliedDiscountPercentage (Edm.Decimal), Message (Edm.String, optional)
 *
 * Shape of the OnSave handler: it decides synchronously, cancels the save
 * when a check is needed, and hands the check to setTimeout(0), which runs it
 * after the OnSave pipeline has unwound. A fresh formContext.data.save()
 * follows once the server allows the value. The obvious alternatives don't
 * work: preventDefault() is honoured only while the handler is still running,
 * and with the app's "Async onSave handler" setting on, a handler that returns
 * a Promise keeps the save open until it settles, so a save it starts itself
 * has been seen to fail because a save is already in progress. The README
 * says which parts of this are documented and which were observed.
 */
var KhQuoteDiscount = (function () {
  "use strict";

  var FIELD = "discountpercentage";
  var API = "kh_RecalculateQuoteDiscount";
  var NOTIFICATION_ID = "kh_quotediscount";
  var FORM_TYPE_UPDATE = 2;
  var SAVE_MODE_AUTOSAVE = 70;

  var MSG_PROGRESS = "Checking the discount...";
  var MSG_CONFIRM_TITLE = "Discount limit";
  var MSG_CONFIRM_CANCEL = "Keep editing";
  var MSG_CHECK_FAILED = "The discount couldn't be checked, so the quote wasn't saved.";
  var MSG_SAVE_FAILED = "The quote wasn't saved: ";

  // What interceptSave does with a save.
  var IGNORE = "ignore"; // not this handler's business
  var ALLOW = "allow"; // nothing to check: let it through
  var BLOCK = "block"; // cancel, start nothing
  var CHECK = "check"; // cancel, then check and save afresh

  // The form fires OnLoad again after a new quote's first save. onLoad swaps
  // out the handler it added earlier instead of stacking a second one.
  var registeredHandler = null;

  function confirmText(applied) {
    return "The discount policy allows " + applied + "% on this quote.";
  }

  function confirmButton(applied) {
    return "Save with " + applied + "%";
  }

  // Request object in the shape Xrm.WebApi.online.execute expects. An
  // Edm.Guid value goes as { guid: id }; the README says why.
  function RecalculateDiscountRequest(quoteId, discountPercentage) {
    this.QuoteId = { guid: quoteId };
    this.DiscountPercentage = discountPercentage;
  }

  RecalculateDiscountRequest.prototype.getMetadata = function () {
    return {
      boundParameter: null,
      operationType: 0,
      operationName: API,
      parameterTypes: {
        QuoteId: { typeName: "Edm.Guid", structuralProperty: 1 },
        DiscountPercentage: { typeName: "Edm.Decimal", structuralProperty: 1 }
      }
    };
  };

  function withoutBraces(id) {
    return String(id).replace(/[{}]/g, "").toLowerCase();
  }

  function messageOf(error) {
    return error && error.message ? String(error.message) : "";
  }

  function showError(formContext, prefix, error) {
    formContext.ui.setFormNotification(prefix + messageOf(error), "ERROR", NOTIFICATION_ID);
  }

  function onLoad(executionContext) {
    var formContext = executionContext.getFormContext();
    var entity = formContext.data.entity;
    if (registeredHandler) {
      entity.removeOnSave(registeredHandler);
      registeredHandler = null;
    }
    var attribute = formContext.getAttribute(FIELD);
    if (!attribute) {
      return;
    }
    var state = { pending: false, approved: undefined };
    registeredHandler = function (saveContext) {
      interceptSave(saveContext, formContext, attribute, state);
    };
    entity.addOnSave(registeredHandler);
  }

  // Decides from the form's current state alone; changes nothing.
  function classify(formContext, attribute, state, saveMode) {
    if (formContext.ui.getFormType() !== FORM_TYPE_UPDATE) {
      return IGNORE; // a new quote has no id to send yet
    }
    var value = attribute.getValue();
    if (value === null || !attribute.getIsDirty() || value === state.approved) {
      return ALLOW;
    }
    if (saveMode === SAVE_MODE_AUTOSAVE || state.pending) {
      return BLOCK;
    }
    return CHECK;
  }

  // The OnSave handler's body. Synchronous on every path: it never returns a
  // Promise and never calls the server, opens a dialog or saves.
  function interceptSave(saveContext, formContext, attribute, state) {
    var eventArgs = saveContext.getEventArgs();
    var verdict = classify(formContext, attribute, state, eventArgs.getSaveMode());
    if (verdict === IGNORE) {
      return;
    }
    if (verdict === ALLOW) {
      // An earlier failure message no longer applies to what is being saved.
      formContext.ui.clearFormNotification(NOTIFICATION_ID);
      return;
    }
    eventArgs.preventDefault();
    if (verdict === CHECK) {
      var requested = attribute.getValue();
      state.pending = true;
      setTimeout(function () {
        checkThenSave(formContext, attribute, state, requested);
      }, 0);
    }
  }

  // Asks the Custom API what the quote may carry. Resolves with
  // { applied, message }; rejects with an Error to show the user. The progress
  // indicator is closed before this settles, whatever the outcome.
  async function fetchAllowedDiscount(formContext, requested) {
    Xrm.Utility.showProgressIndicator(MSG_PROGRESS);
    try {
      var quoteId = withoutBraces(formContext.data.entity.getId());
      var response = await Xrm.WebApi.online.execute(new RecalculateDiscountRequest(quoteId, requested));
      if (response.ok === false) {
        throw new Error("HTTP " + response.status + " " + response.statusText);
      }
      var body = await response.json();
      if (!body || typeof body.AppliedDiscountPercentage !== "number") {
        throw new Error("The response had no AppliedDiscountPercentage.");
      }
      return { applied: body.AppliedDiscountPercentage, message: body.Message };
    } finally {
      Xrm.Utility.closeProgressIndicator();
    }
  }

  // When the server allows less than was typed, the user chooses. Resolves
  // true to carry on with the allowed value (already set on the field).
  async function acceptAllowed(attribute, requested, allowed) {
    if (allowed.applied === requested) {
      return true;
    }
    var answer = await Xrm.Navigation.openConfirmDialog({
      title: MSG_CONFIRM_TITLE,
      text: allowed.message || confirmText(allowed.applied),
      confirmButtonLabel: confirmButton(allowed.applied),
      cancelButtonLabel: MSG_CONFIRM_CANCEL
    });
    if (!answer || !answer.confirmed) {
      return false;
    }
    attribute.setValue(allowed.applied);
    return true;
  }

  // The fresh save. A failure is shown, not retried: the value is approved by
  // then, so the user's next save goes through without a second check.
  function saveApproved(formContext) {
    return formContext.data.save().then(null, function (reason) {
      showError(formContext, MSG_SAVE_FAILED, reason);
    });
  }

  async function checkThenSave(formContext, attribute, state, requested) {
    try {
      formContext.ui.clearFormNotification(NOTIFICATION_ID);
      var allowed = await fetchAllowedDiscount(formContext, requested);
      if (attribute.getValue() !== requested) {
        return; // edited while the check ran; the next save checks the new value
      }
      if (!(await acceptAllowed(attribute, requested, allowed))) {
        return;
      }
      state.approved = allowed.applied;
      state.pending = false;
      await saveApproved(formContext);
    } catch (problem) {
      var detail = messageOf(problem);
      showError(formContext, MSG_CHECK_FAILED + (detail ? " " : ""), problem);
    } finally {
      state.pending = false;
    }
  }

  return { onLoad: onLoad };
})();
