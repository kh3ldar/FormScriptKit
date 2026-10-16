"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { extractScripts, openHtmlWebResource, toHost } = require("../../harness");
const { createDocument } = require("../../harness/dom");

const fixture = (name) => path.join(__dirname, "..", "fixtures", name);
const PAGE = fixture("sample-page.html");
const EXTERNAL = fixture("sample-external.js");
const PAGE_TEXT = fs.readFileSync(PAGE, "utf8");
const PAGE_LINES = PAGE_TEXT.split("\n");
const lineOf = (predicate) => PAGE_LINES.findIndex(predicate) + 1;

test("extractScripts returns inline scripts in order with their start lines", () => {
  const scripts = extractScripts(PAGE_TEXT);
  assert.equal(scripts.length, 3, "the script inside the comment is ignored");

  assert.deepStrictEqual(scripts[0], {
    code: '{"greeting": "hi"}',
    src: null,
    type: "application/json",
    line: lineOf((line) => line.includes('type="application/json"')),
  });
  assert.deepStrictEqual(scripts[1], {
    code: "",
    src: "sample-external.js",
    type: null,
    line: lineOf((line) => line.includes('src="sample-external.js"')),
  });
  assert.equal(scripts[2].src, null);
  assert.equal(scripts[2].type, null);
  assert.equal(scripts[2].line, lineOf((line) => line.trim() === "<script>"));
  assert.ok(scripts[2].code.startsWith("\n(function () {"));
  assert.ok(!scripts.some((script) => script.code.includes("khCommentedOut")));

  assert.deepStrictEqual(extractScripts('<p>x</p>\n<script type="text/x-template">{{ name }}</script>'), [
    { code: "{{ name }}", src: null, type: "text/x-template", line: 2 },
  ]);
  assert.throws(() => extractScripts('<script type="module">import "./kh_other.js";</script>'), /type="module"> is not supported/);
});

test("elements come from the markup's ids", () => {
  const page = openHtmlWebResource(PAGE);

  const company = page.el("company");
  assert.equal(company.tagName, "INPUT");
  assert.equal(company.type, "text");
  assert.equal(company.value, 'Fabrikam & Sons "East"');
  assert.equal(company.getAttribute("value"), 'Fabrikam & Sons "East"');

  assert.equal(page.el("agree").type, "checkbox");
  assert.equal(page.el("agree").checked, true);
  assert.equal(page.el("go").tagName, "BUTTON");
  assert.equal(page.el("go").type, "submit");
  assert.equal(page.el("go").disabled, true);
  assert.equal(page.el("reset").type, "button");
  assert.equal(page.el("reset").disabled, false);
  assert.equal(page.el("notice").hidden, true);
  assert.equal(page.el("notice").textContent, "Hidden text");
  assert.equal(page.el("comments").value, "First line <b>");
  assert.equal(page.el("comments").textContent, "First line <b>");
  assert.equal(page.document.title, "Sample & page");

  assert.equal(page.document.getElementById("nope"), null);
  assert.throws(() => page.el("nope"), /sample-page\.html has no element with id "nope"/);

  assert.throws(() => createDocument('<p id="twice"></p>\n<span id="twice"></span>'), /two elements with id "twice"/);
  const document = createDocument('<!-- <p id="ghost"></p> --><p id="real">x</p><div id="outer"><b>bold</b></div>');
  assert.equal(document.getElementById("ghost"), null);
  assert.equal(document.getElementById("real").textContent, "x");
  assert.equal(document.getElementById("outer").textContent, "", "text is only taken from elements with no child tags");
  assert.equal(document.readyState, "loading");
});

test("the data option arrives once-encoded on location.search", () => {
  const data = JSON.stringify({ note: "a & b = c?" });
  const page = openHtmlWebResource(PAGE, { data });
  assert.equal(page.window.location.search, "?data=" + encodeURIComponent(data));
  assert.equal(page.window.khData, data);
  assert.equal(
    page.window.location.href,
    "https://contoso.crm.dynamics.com/WebResources/sample-page.html?data=" + encodeURIComponent(data),
  );

  assert.equal(openHtmlWebResource(PAGE, { data: "ignored", search: "?data=raw" }).window.khData, "raw");
  assert.equal(openHtmlWebResource(PAGE).window.khData, null);
  assert.throws(() => openHtmlWebResource(PAGE, { data: { note: "x" } }), /data option is a string/);
});

test("click respects disabled; type fires input and change", () => {
  const page = openHtmlWebResource(PAGE);
  const events = () => toHost(page.window.khEvents).filter((name) => !/^(DOMContentLoaded|load)/.test(name));

  page.click("go");
  assert.deepEqual(events(), [], "a disabled button ignores clicks");
  page.click("reset");
  assert.deepEqual(events(), ["reset"]);
  assert.equal(page.el("status").textContent, "reset");
  page.el("go").disabled = false;
  page.click("go");
  assert.deepEqual(events(), ["reset", "go"]);

  page.type("company", "Contoso");
  assert.deepEqual(events().slice(-2), ["input:Contoso", "change:Contoso"]);
  assert.equal(page.el("company").value, "Contoso");

  const event = page.dispatch("company", "change", { detail: 1 });
  assert.equal(event.detail, 1);
  assert.equal(event.target, page.el("company"));
});

test("unsupported DOM members throw with a hint", () => {
  const page = openHtmlWebResource(PAGE);
  const status = page.el("status");
  assert.throws(() => status.innerHTML, /FormScriptKit fake DOM: innerHTML is not supported; build nodes with document\.createElement\(\)/);
  assert.throws(() => {
    status.innerHTML = "<b>bold</b>";
  }, /innerHTML is not supported/);
  assert.throws(() => status.insertAdjacentHTML("beforeend", "<i>x</i>"), /insertAdjacentHTML is not supported/);
  assert.throws(() => page.document.querySelector("#status"), /querySelector is not supported; look elements up by id/);
  assert.throws(() => page.document.write("<p>x</p>"), /document\.write is not supported/);

  const item = page.document.createElement("li");
  item.textContent = "One";
  assert.equal(status.appendChild(item), item);
  assert.equal(item.parentNode, status);
  assert.equal(status.textContent, "One");
  status.textContent = "cleared";
  assert.equal(item.parentNode, null, "setting textContent replaces children");
});

test("DOMContentLoaded and load fire after the scripts run", () => {
  const page = openHtmlWebResource(PAGE);
  assert.equal(page.window.khReadyStateWhileRunning, "loading");
  assert.deepStrictEqual(toHost(page.window.khEvents), ["DOMContentLoaded:complete", "load"]);
  assert.equal(page.document.readyState, "complete");
});

test("window.close is recorded; parent and top are the host, not the page", () => {
  const host = { name: "the form's frame" };
  const page = openHtmlWebResource(PAGE, { host });
  assert.equal(page.window.parent, host);
  assert.equal(page.window.top, host);
  assert.notEqual(page.window.parent, page.window);
  assert.equal(page.window.window, page.window);
  assert.equal(page.window.self, page.window);

  assert.equal(page.closed, false);
  assert.equal(page.closeCalls, 0);
  page.click("done");
  assert.equal(page.closed, true);
  assert.equal(page.closeCalls, 1);
  assert.equal(page.window.closed, true);
  page.click("done");
  assert.equal(page.closeCalls, 2, "the page keeps running after close()");

  const alone = openHtmlWebResource(PAGE);
  assert.deepEqual(alone.window.parent, {});
  assert.notEqual(alone.window.parent, alone.window);
});

test("a page script error points at the HTML file and line", () => {
  const line = lineOf((text) => text.includes("the sample page failed on purpose"));
  assert.throws(
    () => openHtmlWebResource(PAGE, { data: "explode" }),
    (error) => {
      assert.match(error.message, /sample-page\.html/);
      assert.match(error.message, /the sample page failed on purpose/);
      assert.ok(error.cause.stack.includes(`sample-page.html:${line}:`), error.cause.stack);
      return true;
    },
  );
});

test("mapped external scripts load from disk; unmapped ones are listed", () => {
  const unmapped = openHtmlWebResource(PAGE);
  assert.deepEqual(unmapped.skippedScripts, ["sample-external.js"]);
  assert.equal(unmapped.window.khExternalRunsSeen, 0);

  const mapped = openHtmlWebResource(PAGE, { scripts: { "sample-external.js": EXTERNAL } });
  assert.deepEqual(mapped.skippedScripts, []);
  assert.equal(mapped.window.khExternalRuns, 1);
  assert.equal(mapped.window.khExternalRunsSeen, 1, "it ran before the inline script, in document order");
});
