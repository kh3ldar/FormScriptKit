// Fixture: form event handlers that note when they run, for the openForm tests.
var khProbeLog = [];

var KhProbe = {
  onLoad: function (executionContext) {
    khProbeLog.push({ event: "onload", formType: executionContext.getFormContext().ui.getFormType() });
  },
  onLoadAsync: async function (executionContext) {
    await Promise.resolve();
    khProbeLog.push({ event: "onload-async", formType: executionContext.getFormContext().ui.getFormType() });
  },
  recordLoadState: function (executionContext) {
    khProbeLog.push({
      event: "onload-state",
      loadState: executionContext.getEventArgs().getDataLoadState(),
      formType: executionContext.getFormContext().ui.getFormType()
    });
  },
  onSave: function (executionContext) {
    khProbeLog.push({ event: "onsave", formType: executionContext.getFormContext().ui.getFormType() });
  },
  onChange: function (executionContext) {
    khProbeLog.push({ event: "onchange", attribute: executionContext.getEventSource().getName() });
  },
  throwOnLoad: function (executionContext) {
    khProbeLog.push({ event: "onload-throw", formType: executionContext.getFormContext().ui.getFormType() });
    throw new Error("KhProbe.throwOnLoad failed on purpose");
  },
  rejectOnLoad: async function (executionContext) {
    await Promise.resolve();
    khProbeLog.push({ event: "onload-reject", formType: executionContext.getFormContext().ui.getFormType() });
    throw new Error("KhProbe.rejectOnLoad failed on purpose");
  },
  readsSharedState: function () {
    return {
      sameXrm: typeof Xrm === "object",
      timerHandle: setTimeout(function () {}, 1000),
      stored: sessionStorage.getItem("kh_probe")
    };
  }
};
