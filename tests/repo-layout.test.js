"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// `npm test` is `node --test` with no arguments, so Node's default discovery
// decides what runs. These tests keep the layout such that discovery finds
// exactly the test files and nothing else.

const ROOT = path.join(__dirname, "..");
const SKIPPED = new Set(["node_modules", ".git"]);

function walk(dir, found = { files: [], dirs: [] }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.dirs.push(full);
      walk(full, found);
    } else if (entry.isFile()) {
      found.files.push(full);
    }
  }
  return found;
}

const relativeOf = (file) => path.relative(ROOT, file).split(path.sep).join("/");

// Node's default patterns: **/*.test.?(c|m)js, **/*-test.?(c|m)js,
// **/*_test.?(c|m)js, **/test-*.?(c|m)js, **/test.?(c|m)js and
// **/test/**/*.?(c|m)js. Newer Node versions add .ts variants.
const SCRIPT_EXTENSION = /\.(c|m)?(js|ts)$/;

function matchesNodeDefaults(relative) {
  const parts = relative.split("/");
  const base = parts[parts.length - 1];
  if (!SCRIPT_EXTENSION.test(base)) return false;
  if (parts.slice(0, -1).includes("test")) return true;
  const stem = base.replace(SCRIPT_EXTENSION, "");
  return stem === "test" || stem.startsWith("test-") || /[._-]test$/.test(stem);
}

test("no directory is named test", () => {
  const { dirs } = walk(ROOT);
  const named = dirs.filter((dir) => path.basename(dir).toLowerCase() === "test").map(relativeOf);
  assert.deepEqual(named, []);
});

test("only tests/**/*.test.js match node's default test-file patterns", () => {
  const files = walk(ROOT).files.map(relativeOf);
  const discovered = files.filter(matchesNodeDefaults).sort();
  const testFiles = files.filter((file) => /^tests\/.+\.test\.js$/.test(file)).sort();

  for (const file of discovered) assert.match(file, /^tests\/.+\.test\.js$/, `${file} would run as a test`);
  assert.deepEqual(discovered, testFiles);
  assert.ok(testFiles.length >= 12, "expected the full set of test files");
});

test("package.json keeps one test entry point and no dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.main, "harness/index.js");
  for (const field of ["dependencies", "devDependencies"]) {
    assert.ok(pkg[field] === undefined || Object.keys(pkg[field]).length === 0, `${field} should be empty`);
  }
});

test("text files use LF line endings", () => {
  const named = new Set(["LICENSE", ".gitignore", ".gitattributes"]);
  const textFiles = walk(ROOT).files.filter(
    (file) => /\.(js|html|md|json)$/.test(file) || named.has(path.basename(file)),
  );
  assert.ok(textFiles.length > 0);
  const crlf = [];
  const bom = [];
  for (const file of textFiles) {
    const bytes = fs.readFileSync(file);
    if (bytes.includes("\r\n")) crlf.push(relativeOf(file));
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom.push(relativeOf(file));
  }
  assert.deepEqual(crlf, [], "files with CRLF line endings");
  assert.deepEqual(bom, [], "files with a UTF-8 byte order mark");
  assert.equal(fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8"), "* text=auto eol=lf\n");
});
