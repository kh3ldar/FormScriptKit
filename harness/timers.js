"use strict";

// Timers driven by the test. A callback runs only when the test calls next(),
// advance(), runAll() or flush(). `now` counts virtual milliseconds from the
// moment the set was created; Date is not faked.

function hostTurn() {
  // One host macrotask: every microtask queued before it (and every microtask
  // those queue) runs first. Sandbox promises share the host's microtask queue.
  return new Promise((resolve) => setImmediate(resolve));
}

function createTimers() {
  let now = 0;
  let order = 0;
  let nextHandle = 1;
  const scheduled = new Map();

  function schedule(callback, ms, args, repeat) {
    if (typeof callback !== "function") {
      throw new TypeError(
        "FormScriptKit: timer callbacks must be functions; a string would be evaluated as code, which the fake refuses",
      );
    }
    let delay = Number(ms);
    if (!Number.isFinite(delay) || delay < 0) delay = 0;
    if (repeat) delay = Math.max(1, delay);
    const timer = {
      handle: nextHandle,
      due: now + delay,
      order: order,
      callback,
      args,
      interval: repeat ? delay : null,
    };
    nextHandle += 1;
    order += 1;
    scheduled.set(timer.handle, timer);
    return timer.handle;
  }

  function earliest(dueBy) {
    let found = null;
    for (const timer of scheduled.values()) {
      if (dueBy !== undefined && timer.due > dueBy) continue;
      if (!found || timer.due < found.due || (timer.due === found.due && timer.order < found.order)) {
        found = timer;
      }
    }
    return found;
  }

  function fire(timer) {
    if (timer.due > now) now = timer.due;
    if (timer.interval === null) {
      scheduled.delete(timer.handle);
    } else {
      timer.due += timer.interval;
      timer.order = order;
      order += 1;
    }
    timer.callback(...timer.args);
  }

  function clear(handle) {
    scheduled.delete(handle);
  }

  function next() {
    const timer = earliest();
    if (!timer) return false;
    fire(timer);
    return true;
  }

  return {
    setTimeout(callback, ms = 0, ...args) {
      return schedule(callback, ms, args, false);
    },
    setInterval(callback, ms = 0, ...args) {
      return schedule(callback, ms, args, true);
    },
    clearTimeout: clear,
    clearInterval: clear,

    get now() {
      return now;
    },
    get pending() {
      return scheduled.size;
    },

    /** Runs the earliest due timer, moving `now` to its due time. */
    next,

    /** Moves time forward by `ms`, running every timer that falls due on the way. */
    advance(ms) {
      const step = Number(ms);
      if (!Number.isFinite(step) || step < 0) {
        throw new TypeError("FormScriptKit: advance() needs a non-negative number of milliseconds");
      }
      const target = now + step;
      let count = 0;
      for (let timer = earliest(target); timer; timer = earliest(target)) {
        fire(timer);
        count += 1;
      }
      now = target;
      return count;
    },

    /** Runs timers in due order until none remain. A live interval never settles. */
    runAll({ limit = 1000 } = {}) {
      let count = 0;
      while (scheduled.size > 0) {
        if (count >= limit) {
          throw new Error(`FormScriptKit: timers did not settle after ${limit} runs`);
        }
        next();
        count += 1;
      }
      return count;
    },

    /**
     * Drains microtasks, runs a timer due at the current `now`, and repeats
     * until nothing is due after a drain. Zero-delay chains across promise
     * hops run to the end; delayed timers stay pending.
     */
    async flush({ limit = 100 } = {}) {
      let count = 0;
      for (;;) {
        await hostTurn();
        const timer = earliest(now);
        if (!timer) return count;
        if (count >= limit) {
          throw new Error(`FormScriptKit: timers did not settle after ${limit} runs`);
        }
        fire(timer);
        count += 1;
      }
    },

    /** Drains microtasks only. */
    async settle() {
      await hostTurn();
    },
  };
}

module.exports = { createTimers };
