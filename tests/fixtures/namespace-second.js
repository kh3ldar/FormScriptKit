// Fixture: a module object that uses the first file's globals. It reads
// khGreeting once while loading, and calls khShout only when used.
var KhSample = (function () {
  "use strict";

  var greetingAtLoad = khGreeting;
  var count = 0;

  return {
    greetingAtLoad: greetingAtLoad,
    shout: function () {
      return khShout(khGreeting);
    },
    bump: function () {
      count += 1;
      this.lastCount = count;
      return count;
    },
    fail: function () {
      throw new Error("KhSample.fail was asked to fail");
    },
    notAFunction: 42
  };
})();

window.KhSampleAlias = KhSample;
