// Fixture: the trap. An async OnSave handler cancels the save, awaits a
// server call, then awaits its own save. Its promise holds the first save
// open, so the second save is started while the first is still in progress.
var KhNaiveSave = (function () {
  "use strict";

  function NaiveCheckRequest() {}

  NaiveCheckRequest.prototype.getMetadata = function () {
    return { boundParameter: null, operationType: 0, operationName: "kh_NaiveCheck", parameterTypes: {} };
  };

  function onLoad(executionContext) {
    var formContext = executionContext.getFormContext();
    formContext.data.entity.addOnSave(async function (saveContext) {
      saveContext.getEventArgs().preventDefault();
      try {
        await Xrm.WebApi.online.execute(new NaiveCheckRequest());
        await formContext.data.save();
      } catch (error) {
        window.khLastSaveError = error;
      }
    });
  }

  return { onLoad: onLoad };
})();
