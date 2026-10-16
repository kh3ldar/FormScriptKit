// Fixture: reads a namespace that no earlier library defined, while loading.
var KhNeedsHelper = (function () {
  "use strict";
  var helper = KhHelperNotLoaded.create();
  return { helper: helper };
})();
