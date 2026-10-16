# FormScriptKit

A zero-dependency harness for testing Dynamics 365 model-driven form scripts. The classic JavaScript web resources you ship to a form run unchanged in a Node `vm` sandbox, against a hand-written fake of the Xrm client API, under Node's built-in test runner (`node:test`). Worked examples sit on top, each a platform trap or a recurring chore written down as code and tests: an OnSave handler that needs a Custom API's answer before the record may save, an HTML web resource dialog that hands a result back to the form, a small helper library, a Custom Page launcher and ribbon enable rules.

## Why it exists

Form scripts usually get tested by clicking through a form. That is slow, and nobody does it the same way twice.

What makes them awkward to test any other way is what a classic web resource is. It isn't a module. It assumes globals: `Xrm`, `window`, and whatever libraries the form loaded before it. It hangs its handlers off `window` under a name, and the form editor binds events to that name as a string.

The usual workarounds change what ships. Rewrite the scripts as modules and bundle them, or copy the logic into a file a test can import. Either way, the tests now pass against something that isn't on the form.

This repo keeps the shipped file as the unit under test. It is read from disk, run in a `vm` context that stands in for the form's script frame, and wired to a fake `Xrm`. The patterns come from a production Dynamics 365 implementation the author built; the code here is a fresh, generic rewrite.

## What it does

**Loads web resources the way a form does.** Several files go into one sandbox, in form-library order, sharing globals. Namespaced scripts (an IIFE returning a module object) and global-function scripts both work, including top-level `const` and `class`.

**Binds handlers by the names you type into the form editor.** `handlers: { onLoad: ["KhQuoteDiscount.onLoad"] }` resolves the dotted name in the sandbox. A name that doesn't resolve fails when the form opens in the test, and the error names the handler, the missing segment and the files that were loaded. OnLoad runs when the test fires it, and again after a new record's first save, as it does on a form.

**Fakes the Client API a typical form script touches.** Typed attributes with value validation, dirty tracking and OnChange; controls with visibility, disabled state, labels and notifications; form notifications; tabs and sections; the entity, its save pipeline and `refresh`; OnLoad and OnSave event args; `Xrm.WebApi` retrieve, retrieve multiple, create, update and `online.execute`; `Xrm.Navigation` alert, confirm and `navigateTo`; `Xrm.App.addGlobalNotification`; the progress indicator; `getGlobalContext` (the client URL and the user's id, name, language and roles). Plus deterministic timers and Web Storage.

**Runs HTML web resources.** The inline script of an HTML page runs against a small DOM built from the page's own markup. Clicks, typing, `window.close()` and storage are all observable from the test.

**Five worked examples.** [Example A](examples/quote-discount-onsave/kh_quotediscount.js) is an OnSave handler that calls a Custom API before the record may save, without tripping the nested-save failure. [Example B](examples/quick-note-dialog/) is an HTML dialog opened with `navigateTo` that hands its result back to the form script without touching another frame. [Example C](examples/form-helpers/kh_formhelpers.js) is five small form-script helpers: an error boundary for event handlers, a progress indicator that always closes, a confirm dialog that is waited out before progress shows, a role check that reads the roles once, and a ribbon action runner. [Example D](examples/custom-page-launcher/kh_pagelauncher.js) opens a Custom Page in a dialog sized beforehand and takes its result back through localStorage. [Example E](examples/ribbon-rules/kh_quoteribbonrules.js) is a set of ribbon enable rules that each state whether they fail open or closed, plus a poll that refreshes the ribbon only when a rule's answer changes.

## Design highlights

**The code under test is the file on disk.** [sandbox.js](harness/sandbox.js) reads each file as UTF-8 and runs its text with `vm.runInContext`, using the absolute path as the filename. No wrapping, no transform, no cache: two sandboxes loading one file read it twice, and stack traces point at the file you ship.

**One sandbox per form.** `window`, `self`, `top` and `parent` are all the sandbox's global, so `window.KhSample = ...` is readable as bare `KhSample`, and libraries on one form share state the way they do in the form's script frame. No Node globals are defined inside: `require`, `process`, `module`, `document` and `fetch` are undefined. `URL` and `URLSearchParams` are the host's. The sandbox is there for fidelity, not security: [`node:vm` is not a security mechanism](https://nodejs.org/api/vm.html), and the injected fakes and timers are host functions.

**Handlers are bound by name.** [open-form.js](harness/open-form.js) resolves every configured handler before any of them runs, and registers the configured OnSave and OnChange handlers before OnLoad can add its own, which is the order a form uses. `sandbox.fn` checks the name against a dotted-identifier pattern, evaluates only the first segment, as a bare identifier (so top-level `const`, `let` and `class` bindings resolve), and reads the rest as properties; the string is never evaluated as arbitrary code. OnLoad handlers get event args whose `getDataLoadState()` returns 1, and run again with 2 after a create form's first save: the two cases the [OnLoad event](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/events/form-onload) page lists.

**The save pipeline follows Microsoft's docs where they say something.** [form.js](harness/form.js) calls OnSave handlers synchronously, in registration order, with one shared event-args object. `preventDefault()` counts only while that loop runs, as the [OnSave event](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/events/form-onsave) documentation says; a later call is ignored and flagged on the attempt record. As that page lists, `data.save()` runs the handlers only when the form has unsaved data, while a user save and `entity.save()` run them even when nothing changed. A handler that returns a Promise holds the save open until it settles, which is the documented behaviour when the app's "Async onSave handler" setting is on. Microsoft requires opting in to that setting; `asyncSaveHandlers` defaults to `true` to model an app that has, and `false` makes the fake ignore returned promises (a [declared choice](#declared-choices)). One rule is an observation, not documentation: a save started while another is in progress is rejected (see [Scope and trade-offs](#scope-and-trade-offs)). One test loads [a naive async handler](tests/fixtures/naive-async-onsave.js) to show the trap as the harness models it; it demonstrates the model, not the platform.

**Loud fakes.** An unscripted Web API call, confirm dialog or navigation rejects with a message naming the call (`no fake response for WebApi.online.execute(kh_RecalculateQuoteDiscount)`) and is listed in `xrm.unhandled`. `setValue` with the wrong type throws a `TypeError`. `execute` refuses a request without `getMetadata`, an action or function request carrying a property that `getMetadata().parameterTypes` doesn't declare, and an `Edm.Guid` parameter passed as a bare string rather than `{ guid: "<id>" }` (a [declared choice](#declared-choices)). `navigateTo` refuses an object as a web resource's `data`, and an entity list in a dialog. `Xrm.Page` doesn't exist, so a script that reaches for it fails in the test, not on the form.

**Realm-aware recording.** Objects built inside a vm context carry that context's prototypes, so `assert.deepStrictEqual` against a literal in the test fails even when the contents match. [realm.js](harness/realm.js) copies across the boundary: everything the harness records (calls, saves, notifications, logs) is copied into the test's realm at the moment of the call, and everything handed to scripts (attribute values, responder results, promises, errors) into the sandbox's.

**Deterministic timers.** [timers.js](harness/timers.js) runs a callback only when the test says so. `flush()` drains microtasks and runs zero-delay timers until nothing is due, which is exactly what a deferred continuation needs; delayed timers stay pending until the test moves time with `advance()`.

**The HTML DOM comes from the markup.** [dom.js](harness/dom.js) creates an element for every tag with an `id`, so renaming an id in the page fails the test that uses it. `click()` does nothing on a disabled element. `innerHTML`, `querySelector` and `document.write` throw with a hint, on purpose: dialog code that builds nodes with `createElement` and `textContent` is the kind this harness tests.

**Helpers that fail in a known way.** Example C's `safeHandler` turns a throwing or rejecting handler into a form notification keyed by the handler's name, so a repeat replaces it and a later success clears it; a test shows the same throw, unwrapped, landing in the harness's script errors. `runRibbonAction` resolves `{ ok: true, result }` or `{ ok: false, stage }` instead of rejecting, shows the server's own message when the Custom API refuses, and closes the progress indicator on every exit. The confirm wait (two animation frames, then 150 ms) is a defence the author found necessary in production; Microsoft doesn't document the stuck dialog it guards against.

**Sizing before opening, cleanup on every launch.** `navigateTo` takes a dialog's size when it opens, and the Client API has no call to change it afterwards. So Example D counts the quote's lines first, asking for no more rows than could still change the height, and caps the height at 80% of the window, with a fixed fallback if the count can't be read. The page's result sits in localStorage under a per-record key with a timestamp; each launch removes this launcher's keys older than an hour or unreadable, and storage that throws is treated as empty.

**Every rule says what "don't know" means.** Example E's rules answer synchronously from what is on the form or in memory, so a rule can meet a fact it can't read yet. A table of policies, one per rule, decides: hide the button (fail-closed) or show it (fail-open). A thrown error takes the same answer. Unified Interface also accepts a rule that returns a Promise ([enable rules](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/define-ribbon-enable-rules)), but that reads the server on every ribbon evaluation and answers false after a 10-second timeout whatever the rule's policy. Instead, a poll reads the one slow fact, compares a rule's answer before and after each read, and calls `refreshRibbon` only when it differs.

## Architecture

```
harness/
  index.js          the one module tests require
  sandbox.js        createSandbox, loadWebResources: one vm context per form
  realm.js          copyInto/toHost, fakeGuid, xrmError, xrmResponse, collections
  timers.js         deterministic setTimeout/setInterval with flush()
  storage.js        in-memory Web Storage that can be blocked
  console.js        a console that records instead of printing
  attributes.js     attribute types, value validation, dirty equality
  form.js           createForm: controls, ui, tabs, entity, save pipeline, refresh
  xrm.js            createXrm: WebApi, Navigation, Utility, App
  open-form.js      openForm: sandbox + form + Xrm + timers, handlers bound by name
  dom.js            the fake DOM built from markup
  html.js           extractScripts, openHtmlWebResource
  constants.js      SAVE_MODE, FORM_TYPE, LOAD_STATE, SAVE_IN_PROGRESS, SAVE_CANCELLED
examples/
  quote-discount-onsave/   Example A: kh_quotediscount.js
  quick-note-dialog/       Example B: kh_quicknote.js, kh_quicknotedialog.html
  form-helpers/            Example C: kh_formhelpers.js
  custom-page-launcher/    Example D: kh_pagelauncher.js
  ribbon-rules/            Example E: kh_quoteribbonrules.js
tests/
  harness/          the harness's own tests
  examples/         the examples' tests
  fixtures/         small web resources and a sample page for the harness tests
```

| Export | Returns | Key options |
|---|---|---|
| `openForm(options)` | `{ sandbox, form, xrm, timers, loads, fireOnLoad(), settle(), call() }` | `libraries`, `entityName`, `id`, `attributes`, `tabs`, `handlers`, `onLoadAfterCreate`, `xrm`, storages |
| `createSandbox(options)`, `loadWebResources(files, options)` | a sandbox: `load`, `run`, `define`, `get`, `fn`, `realm`, `logs` | `globals`, `root`, `timers`, `console`, storages |
| `createForm(options)` | a form fixture: `formContext` plus `userEdit`, `userSave`, `saves`, `saveAttempts`, notifications, `failNextSave`, `setServerValues` | `entityName`, `id`, `formType`, `attributes`, `tabs`, `asyncSaveHandlers`, `realm` |
| `createXrm(options)` | an Xrm fixture: `Xrm` plus `calls`, `callsTo`, `unhandled`, responders, progress state | `globalContext`, `realm` |
| `openHtmlWebResource(file, options)` | a page: `window`, `document`, `el`, `click`, `type`, `dispatch`, `closed`, `closeCalls`, `logs` | `data`, `search`, `sessionStorage`, `host`, `scripts` |
| `extractScripts(html)` | `[{ code, src, type, line }]` | |
| `createTimers()`, `createStorage()`, `createConsole()` | the building blocks the above use | |
| `toHost`, `copyInto`, `fakeGuid`, `bracedId`, `bareId`, `deferred`, `xrmError`, `xrmResponse` | helpers | |
| `SAVE_MODE`, `FORM_TYPE`, `LOAD_STATE`, `SAVE_IN_PROGRESS`, `SAVE_CANCELLED` | constants | |

**Fixture versus `formContext`.** Every fake is a fixture object. Its Xrm-shaped part (`form.formContext`, `xrm.Xrm`) carries only real Client API members; everything a test uses to drive or inspect it (`userSave`, `saves`, `formNotifications`, responders) sits on the fixture. A test checks that the fixtures' test-only members aren't reachable from `formContext` or `Xrm`. Nothing tests the other direction, that every member they do carry exists on the platform; that rests on reading the docs.

A test, end to end, as a file in `tests/examples/`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { openForm, fakeGuid } = require("../../harness");

test("an allowed discount is saved by one fresh save", async () => {
  const quote = openForm({
    libraries: [path.join(__dirname, "..", "..", "examples", "quote-discount-onsave", "kh_quotediscount.js")],
    entityName: "quote",
    id: fakeGuid(42),
    attributes: { discountpercentage: { type: "decimal", value: 5 } },
    handlers: { onLoad: ["KhQuoteDiscount.onLoad"] },
  });
  quote.xrm.webApi.respondToExecute("kh_RecalculateQuoteDiscount", () => ({ AppliedDiscountPercentage: 12.5 }));
  await quote.fireOnLoad();

  quote.form.userEdit("discountpercentage", 12.5);
  await quote.form.userSave(); // cancelled by the handler; the check is deferred
  await quote.settle();        // runs the check, then the fresh save

  assert.deepEqual(quote.form.saves[0].values, { discountpercentage: 12.5 });
});
```

### Faked and not faked

Faked: the list under [What it does](#what-it-does). Not faked: `Xrm.Page`; `Xrm.App` apart from `addGlobalNotification`, `Xrm.Device`, `Xrm.Encoding` and `Xrm.Panel`; `Xrm.Utility.getEntityMetadata`, `lookupObjects` and `openWebResource`; `Xrm.Navigation.openForm`, `openUrl`, `openErrorDialog` and `openFile`; `Xrm.WebApi.deleteRecord`, `online.executeMultiple` and offline mode; `formContext.data.addOnLoad`, `ui.addOnLoad`, `data.entity.addOnPostSave`, `data.process` and `data.entity.attributes`; the execution context's `getDepth`, `getSharedVariable` and `setSharedVariable`; `preventDefaultOnError` on OnSave event args; the rest of `getGlobalContext` (`organizationSettings`, `getVersion`, `getCurrentAppUrl` and the other `userSettings` members); `ui.close`, `ui.controls`, `ui.formSelector`, `ui.navigation`, `ui.quickForms` and the header and footer sections; attribute `getOptions`, `getInitialValue`, min, max, precision, formats and multiselect choices; control `setFocus`, `addNotification`, lookup filters, subgrid and web resource controls; required-field enforcement on save; the async OnSave timeout; business rules; ribbon and command evaluation; browser layout, CSS and network. A script that calls a missing member gets a `TypeError`, not a silent pass.

### Declared choices

Where Microsoft's docs are silent, the fake picks a behaviour and says so here.

- **Dirty** means different from the loaded value, or from the value after the last save or refresh. Edit then revert is clean. Lookups compare by `entityType` and id, ignoring braces and case.
- `clearFormNotification` returns `false` for an id that wasn't set.
- `refresh()` discards unsaved values, after one simulated round trip, so nothing changes before it has returned. Values queued with `setServerValues` arrive on the next refresh, as if another user had saved them. A refresh doesn't fire OnLoad: the OnLoad page lists only the first load and a new record's first save, although `getDataLoadState` also defines 3 (Refresh).
- `data.save()` with nothing to save resolves at once, without running OnSave, and records an attempt with outcome `"clean"`.
- After a create form's first save, the save's promise settles once the re-fired OnLoad handlers, and any promises they return, have settled. `onLoadAfterCreate: false` turns the re-fire off.
- With `asyncSaveHandlers: false`, the fake ignores promises that OnSave handlers return. Microsoft doesn't say what happens to them when the app setting is off.
- A script save cancelled by an OnSave handler rejects with `SAVE_CANCELLED`, a harness value. Code under test shouldn't depend on its shape.
- A save started during another save rejects with `SAVE_IN_PROGRESS`, `{ errorCode: 2200000003, message: "Please wait while saving is completed" }`, an observed value rather than a documented one (see [Scope and trade-offs](#scope-and-trade-offs)).
- Required levels are recorded, not enforced on save.
- The async OnSave 10-second timeout is not modelled.
- `getId()` returns the id braced and upper-cased, the documented lookup id format.
- `execute` wants an `Edm.Guid` parameter as `{ guid: "<id>" }`. The [execute](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-webapi/online/execute) page doesn't say how to pass one; it is the shape that the Dataverse REST Builder, a tool the page points to, generates. In the production implementation these patterns come from, a bare string reached the server as "undefined".

## Hosting

Nothing in this repo was deployed. This is how the examples would be registered on a real form.

**Example A.** Upload `kh_quotediscount.js` as a Script web resource and add it as a library on the quote main form. Register `KhQuoteDiscount.onLoad` on the form's OnLoad event with "Pass execution context as first parameter" ticked. It adds its own OnSave handler; there is nothing to register on OnSave. The form fires OnLoad again after a new quote's first save ([OnLoad event](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/events/form-onload)), so `onLoad` removes any handler it added earlier before adding a fresh one. Without that, a quote created on the form could carry two handlers and get two checks per save.

**Example B.** Upload `kh_quicknote.js` (Script) and `kh_quicknotedialog.html` (Webpage (HTML)). The page's registered name must be exactly `kh_quicknotedialog.html`, the name the script passes to `navigateTo`. Add a command bar button to the opportunity main form, with the command designer or ribbon XML, whose action calls `KhQuickNote.open` with two parameters: PrimaryControl, and the string `opportunities`. The entity set name is needed for the `@odata.bind` and can't be derived without a metadata call.

**Examples C, D and E.** Upload each as a Script web resource. Example C is a library: load it on the forms and ribbons that call it. For Example D, add a command bar button on the quote form calling `KhPageLauncher.openLineEditor` with PrimaryControl. It asks for the quote to be saved first, because it refreshes the form after the page saves. The Custom Page `kh_quotelineeditor_1a2b3` is not in this repo, and must write `{ at, saved, message? }` under `kh_pagelauncher_result_<quote id>` in localStorage before it closes. Power Fx has no function for writing a localStorage key of your choosing, so in practice that takes a code component on the page. For Example E, register `KhQuoteRibbon.startLinePoll` on the quote form's OnLoad with the execution context passed, and give each button an EnableRule that is a CustomRule calling the matching function with PrimaryControl. A rule library that loads without Example C leaves `canOverrideDiscount` hidden, by its policy.

**Using the harness in another repo.** Copy `harness/` (it has no dependencies) and require `harness/index.js` from your tests. Keep `harness/`, fixtures and the web resources under test out of any folder named `test`, and give helpers names that don't match [Node's default test-file patterns](https://nodejs.org/api/test.html#running-tests-from-the-command-line), or `node --test` will run them as tests.

## Configuration

**Example A's Custom API**, `kh_RecalculateQuoteDiscount`:

| Part | Name | Type |
|---|---|---|
| Binding | unbound (global) | |
| Kind | action, not a function | |
| Request parameter | `QuoteId` | Guid |
| Request parameter | `DiscountPercentage` | Decimal |
| Response property | `AppliedDiscountPercentage` | Decimal |
| Response property | `Message` (optional) | String |

The script sends `QuoteId` as `{ guid: "<id>" }` (see [Declared choices](#declared-choices)). The server-side implementation is not part of this repo; the tests fake its response.

**Example A's behaviour.** A save someone asked for, with a changed and non-empty discount, is cancelled at once. The check runs after the OnSave handler has returned. An allowed value is saved by one fresh `formContext.data.save()`; a reduced value asks the user first, and declining keeps their value unsaved. A save that needs no check clears the example's earlier error message. Autosave (save mode 70) is cancelled while a discount is unchecked. Save modes only inform OnSave handlers ([data.save](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/formcontext-data/save), [getSaveMode](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/save-event-arguments/getsavemode)), so the follow-up is a plain save: Save & Close and Save & New end with the form saved and still open.

**Example B's contracts.**

- Into the page: `data` is `JSON.stringify({ resultKey, recordName })`, where `resultKey` is a one-time `kh_quicknote_<milliseconds>-<random hex>` key.
- Out of the page: `{ confirmed: true, title, text }` in `sessionStorage` under `resultKey`, both strings trimmed. The form script reads and removes the entry once `navigateTo` resolves.
- The note: an `annotation` with `notetext`, `subject` when a title was given, and `objectid_<table>@odata.bind` pointing at the open record.

**Messages** are constants at the top of each example file.

## Scope and trade-offs

**What the harness can't see: the form itself.** A library missing from the form, a handler name typed differently in the form editor, a column renamed or removed in Dataverse, the library order configured on the form, business rules, ribbon rules, security roles and the real UI all pass green here. The harness checks the names and the order you give it, not your form's configuration. Closing that gap needs an end-to-end run against a real environment, for example a browser automation suite; none is included and none was run.

**The fake is written from the docs, not extracted from the platform.** Where Microsoft is silent, behaviour is a [declared choice](#declared-choices). The fake is stricter than the platform about value types, on purpose: a wrong type is cheaper to find in a test than on a form.

**The nested-save failure, stated carefully.** Microsoft documents that `preventDefault` only works synchronously; that with the "Async onSave handler" app setting on, the save waits for a Promise an OnSave handler returns (up to 10 seconds per promise unless `disableAsyncTimeout` is called); and that a rejected promise doesn't stop the save. So a decision that needs a server round trip, or the user's answer, arrives after the save it was meant to cancel. Microsoft doesn't describe what happens when a save is started while another is still in progress. In the production implementation these patterns come from, a handler that awaited its own follow-up `formContext.data.save()` had that save rejected with errorCode 2200000003 and the message "Please wait while saving is completed". That code isn't in Microsoft's documentation as far as the author found. The harness reproduces it as an observation, and the example doesn't depend on the number: it cancels synchronously, defers the rest with `setTimeout(0)` so it runs after the save pipeline unwinds, and starts a fresh save only after the Custom API has answered.

**What Example A costs.** One user save becomes two saves. The follow-up is always a plain save, so it doesn't finish whatever else the cancelled save was part of: closing the form (Save & Close), opening a new one (Save & New), navigating away with autosave on (which [getSaveMode](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/save-event-arguments/getsavemode) reports as Save and Close, mode 2), or Assign (mode 47). The user repeats that action after the save. Autosave waits while a discount is unchecked. A create form saves unchecked, because there is no id to send yet. The example also assumes the cancelled save has ended by the time the Custom API answers. If another library's OnSave handler returns a Promise that is still pending then, the cancelled save is still in progress, so the follow-up save fails with the in-progress error and the form shows "The quote wasn't saved: Please wait while saving is completed". The value is approved by then, so the user's next save goes through without a second check; [a test](tests/examples/quote-discount-onsave.test.js) pins this. And a client-side check only binds this form: a real policy also needs server-side enforcement (a plugin), which this repo doesn't include. If all you need is to enforce a rule, a synchronous plugin is the better home; this pattern is for when the form needs the server's answer, or the user's, before it saves.

**Example B and the missing return channel.** Per [navigateTo](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-navigation/navigateto), an HTML web resource dialog returns no value: its promise resolves when the dialog closes. `window.returnValue` is undocumented, and a callback parked on `window.top` (or `window.parent.parent`) is what the [avoid-window-top](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/powerapps-checker/rules/web/avoid-window-top) checker rule warns against. The example stores the result in sessionStorage under a one-time key and reads it when the dialog's promise resolves. That assumes both frames share the org's origin and the browser tab, which is how web resources are served. `window.close()` is best effort: a [Dynamics community support article](https://community.dynamics.com/article/KA-25752) says it doesn't work in `navigateTo` dialogs. If it doesn't, the user closes with the X and the note is still created, because the result was stored before the close attempt. `data` travels in the URL, so keep it small (a large input can use the same storage handoff), and angle brackets are stripped from the record name because the platform rejects them in query-string parameters ([HTML web resources](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/webpage-html-web-resources)). The timeline isn't refreshed after the note is created.

**What Examples C to E don't do.** None of it ran on a real form. Example E's rules only gate what a button shows; they enforce nothing, and the Custom API behind a button must refuse what the rule would hide. Which answer the platform takes from a rule that throws isn't something Microsoft documents as far as the author found, so the wrapper never lets one throw. The Client API has no unload event, so Example E's poll can't tell when the form closes: it stops when OnLoad starts a new one, when `stopLinePoll` is called, when `refreshRibbon` throws, or after five minutes of reads, and from then on the rule keeps the last count it read. Example D reads localStorage on the assumption that the page and the form share the org's origin. `addGlobalNotification` is used with `type: 2`, the one value its [reference page](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-app/addglobalnotification) documents, and the fake refuses anything else.

**The fake DOM is not a browser.** Ids are found by regex in the markup. There is no tree built from markup, no CSS, no layout, no selectors and no `innerHTML`. That is enough for the small pages HTML dialogs usually are, and it keeps the repo dependency-free; a page that needs more wants jsdom.

**Node's discovery rules shape the layout.** `npm test` is `node --test` with no arguments. A directory argument (`node --test tests/`) fails on Node 25, which treats the directory as a module to load; a glob argument (`node --test "tests/**/*.test.js"`) works on Node 25 but fails on Node 20, which has no glob arguments. With no arguments, discovery behaves the same on both. The price is that every file matching Node's default patterns runs as a test, so tests live under `tests/` and end in `.test.js`, no folder is named `test`, and [a repo test](tests/repo-layout.test.js) keeps fixtures and helpers from matching.

## Building

```bash
npm test
```

There is no install step, because there are no dependencies. Node 20 or later is required. The script is a plain `node` command with no shell syntax, and paths in the tests are built with `node:path`, so it should run the same on macOS; that is untested. It was verified on Windows only, in PowerShell and Git Bash, with Node 25 (`npm test`) and Node 20.20 (`npx -y node@20 --test`); every test passed on both.

### On running it locally

There is nothing to start. The harness is a test library, and the examples are web resources for a model-driven app.

Everything in this repo was verified with the test suite alone. No Dataverse environment was used: the examples were not deployed, and the Custom API in Example A has no server-side implementation here. Running the examples for real means deploying them as described in [Hosting](#hosting), to an environment where `kh_RecalculateQuoteDiscount` exists.

## Stack

JavaScript: ES2017 classic scripts for the web resources, CommonJS on Node 20+ for the harness · `node:test`, `node:assert`, `node:vm` · no runtime or dev dependencies · MIT
