// Fixture: top-level lexical bindings, which are not properties of window.
const KH_LIMIT = 3;

class KhCounter {
  constructor() {
    this.value = 0;
  }

  next() {
    this.value = Math.min(this.value + 1, KH_LIMIT);
    return this.value;
  }
}
