/*
 * kh_quoteribbonrules.js (Script web resource): enable rules for three
 * command bar buttons on the quote main form, each with a stated policy for
 * what to do when the rule can't tell.
 *
 * Why a policy at all: these rules answer synchronously, from what is already
 * on the form or in memory. Sometimes that is not enough (a fact is still
 * being fetched, a column isn't on this form, a library didn't load). Each
 * rule says what "don't know" means for its button:
 *
 *   fail-closed  hide the button. For actions that are wrong to offer by
 *                mistake.
 *   fail-open    show the button. For corrective actions the user must be
 *                able to reach, where the server is the one that refuses.
 *
 * A rule never enforces anything. The Custom API behind each button has to
 * refuse what the rule would have hidden.
 *
 * The wrapper always returns true or false, also when the evaluation throws.
 * What the platform does with a rule that throws isn't something this file
 * relies on.
 *
 * One fact isn't on the form: whether the quote has any lines. Unified
 * Interface would also take a rule that returns a Promise (false if it hasn't
 * settled in 10 seconds), but that rule would read the server on every ribbon
 * evaluation, would run again only when the platform re-evaluates the ribbon,
 * and would answer false on a timeout whatever its policy. So startLinePoll,
 * registered on the form's OnLoad, reads the count on a timer and calls
 * refreshRibbon only when a rule's answer changes. The Client API has no
 * unload event, so the poll also stops by itself after POLL_READS reads, and
 * as soon as the ribbon can't be refreshed.
 *
 * Ribbon wiring (not part of this repo): each button's EnableRule is a
 * CustomRule calling the function below with PrimaryControl as a parameter.
 */
var KhQuoteRibbon = (function () {
  "use strict";

  var FAIL_OPEN = "fail-open";
  var FAIL_CLOSED = "fail-closed";

  var POLL_MS = 5000;
  var POLL_READS = 60; // five minutes; after that the last count stands
  var FORM_TYPE_UPDATE = 2;
  var STATE_DRAFT = 0;
  var STATE_ACTIVE = 1;
  var DISCOUNT_ROLES = ["sales manager"];

  // What each rule does when it can't tell. Read by the wrapper below, and
  // exported so a reader (or a test) can see every policy in one place.
  var POLICIES = {
    canSendForReview: FAIL_CLOSED, // wrong to offer on an empty quote
    canWithdrawReview: FAIL_OPEN, // a corrective action; the server refuses
    canOverrideDiscount: FAIL_CLOSED // gated by a role this file can't verify alone
  };

  // The line count the poll last read, with the quote it was read for. null
  // until the first read answers.
  var knownLines = null;
  var pollGeneration = 0;
  var pollTimer = null;

  function withoutBraces(id) {
    return String(id).replace(/[{}]/g, "").toLowerCase();
  }

  // ---- the policy wrapper --------------------------------------------------

  // `evaluate` returns true, false, or undefined for "can't tell". Anything
  // else, and any throw, also counts as "can't tell".
  function rule(name, evaluate) {
    var policy = POLICIES[name];
    return function (primaryControl) {
      var answer;
      try {
        answer = evaluate(primaryControl);
      } catch (error) {
        console.warn("[kh] ribbon rule " + name + " threw:", error);
        answer = undefined;
      }
      if (answer === true || answer === false) {
        return answer;
      }
      return policy === FAIL_OPEN;
    };
  }

  function stateOf(formContext) {
    var attribute = formContext.getAttribute("statecode");
    return attribute ? attribute.getValue() : undefined;
  }

  function quoteId(formContext) {
    var id = formContext.data.entity.getId();
    return id ? withoutBraces(id) : "";
  }

  // ---- the rules -----------------------------------------------------------

  var canSendForReview = rule("canSendForReview", function (formContext) {
    if (formContext.ui.getFormType() !== FORM_TYPE_UPDATE) {
      return false;
    }
    var state = stateOf(formContext);
    if (state === undefined) {
      return undefined; // the column isn't on this form
    }
    if (state !== STATE_DRAFT) {
      return false;
    }
    // The count must be for the quote on this form.
    if (knownLines === null || knownLines.quoteId !== quoteId(formContext)) {
      return undefined;
    }
    return knownLines.count > 0;
  });

  var canWithdrawReview = rule("canWithdrawReview", function (formContext) {
    var state = stateOf(formContext);
    return state === undefined ? undefined : state === STATE_ACTIVE;
  });

  var canOverrideDiscount = rule("canOverrideDiscount", function () {
    if (typeof KhFormHelpers === "undefined") {
      return undefined; // the helper library isn't loaded on this form
    }
    return KhFormHelpers.hasAnyRole(DISCOUNT_ROLES);
  });

  // ---- the poll ------------------------------------------------------------

  async function readLineCount(id) {
    var result = await Xrm.WebApi.retrieveMultipleRecords(
      "quotedetail",
      "?$select=quotedetailid&$filter=_quoteid_value eq " + id + "&$top=1"
    );
    return result.entities.length;
  }

  // One read. If it changes what canSendForReview answers, the ribbon is
  // refreshed; if the read fails, the last known count stays. Resolves false
  // when the poll should stop: the ribbon couldn't be refreshed, which most
  // likely means the form is gone.
  async function tick(formContext, id) {
    var count;
    try {
      count = await readLineCount(id);
    } catch (error) {
      console.warn("[kh] the line count couldn't be read:", error);
      return true;
    }
    var before = canSendForReview(formContext);
    knownLines = { quoteId: id, count: count };
    if (canSendForReview(formContext) === before) {
      return true;
    }
    try {
      formContext.ui.refreshRibbon(true);
      return true;
    } catch (error) {
      console.warn("[kh] the ribbon couldn't be refreshed, so the line poll stops:", error);
      return false;
    }
  }

  function stopLinePoll() {
    pollGeneration += 1;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // Register on the form's OnLoad, with "Pass execution context" ticked.
  // OnLoad can fire again after a new record's first save, so a second start
  // replaces the first rather than adding a second timer.
  function startLinePoll(executionContext) {
    var formContext = executionContext.getFormContext();
    stopLinePoll();
    var id = quoteId(formContext);
    if (!id) {
      return; // nothing to count on a new record
    }
    var generation = pollGeneration;
    var reads = 0;

    async function loop() {
      reads += 1;
      var carryOn = await tick(formContext, id);
      if (carryOn && reads < POLL_READS && generation === pollGeneration) {
        pollTimer = setTimeout(loop, POLL_MS);
      }
    }
    loop();
  }

  return {
    policies: POLICIES,
    canSendForReview: canSendForReview,
    canWithdrawReview: canWithdrawReview,
    canOverrideDiscount: canOverrideDiscount,
    startLinePoll: startLinePoll,
    stopLinePoll: stopLinePoll
  };
})();
