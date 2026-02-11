import assert from "node:assert/strict";

// NOTE: This script runs after `tsc`, so it imports from dist/.
import { buildUrnContainerTree, prefixToBreadcrumb, matchesUrnPrefix } from "../dist/lib/tree.js";

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

test("buildUrnContainerTree aggregates counts across container prefixes", () => {
  const sessions = {
    a: { id: "a", url: "https://chatgpt.com/c/a", title: "A", createdAt: "2026-02-10T00:00:00.000Z", lastSeenAt: "2026-02-10T00:00:00.000Z", lastDownloadAt: null, downloadCount: 0 },
    b: { id: "b", url: "https://chatgpt.com/c/b", title: "B", createdAt: "2026-02-10T00:00:00.000Z", lastSeenAt: "2026-02-10T00:00:00.000Z", lastDownloadAt: null, downloadCount: 0 }
  };

  const commits = [
    { id: "1", sessionId: "a", sessionUrl: sessions.a.url, capturedAt: "2026-02-10T01:00:00.000Z", startTime: null, endTime: null, state: "complete", filename: "x.zip", url: null, finalUrl: null, referrer: sessions.a.url, mime: null, totalBytes: null, urn: "urn:feat:sessions:chrome:download-commits", urnSource: "t" },
    { id: "2", sessionId: "a", sessionUrl: sessions.a.url, capturedAt: "2026-02-10T02:00:00.000Z", startTime: null, endTime: null, state: "complete", filename: "y.zip", url: null, finalUrl: null, referrer: sessions.a.url, mime: null, totalBytes: null, urn: "urn:feat:sessions:chrome:download-commits", urnSource: "t" },
    { id: "3", sessionId: "b", sessionUrl: sessions.b.url, capturedAt: "2026-02-10T03:00:00.000Z", startTime: null, endTime: null, state: "complete", filename: "z.zip", url: null, finalUrl: null, referrer: sessions.b.url, mime: null, totalBytes: null, urn: "urn:feat:sessions:chrome:other", urnSource: "t" },
    { id: "4", sessionId: "b", sessionUrl: sessions.b.url, capturedAt: "2026-02-10T04:00:00.000Z", startTime: null, endTime: null, state: "complete", filename: "w.txt", url: null, finalUrl: null, referrer: sessions.b.url, mime: null, totalBytes: null, urn: "urn:test:foo:bar", urnSource: "t" },
    { id: "5", sessionId: "b", sessionUrl: sessions.b.url, capturedAt: "2026-02-10T05:00:00.000Z", startTime: null, endTime: null, state: "complete", filename: "u.bin", url: null, finalUrl: null, referrer: sessions.b.url, mime: null, totalBytes: null, urn: null, urnSource: null }
  ];

  const model = buildUrnContainerTree(commits, sessions, { includeUnknown: true });

  const rootFeat = model.byId.get("urn:feat");
  assert.ok(rootFeat);
  assert.equal(rootFeat.commitCount, 3);
  assert.equal(rootFeat.sessionCount, 2);

  const chrome = model.byId.get("urn:feat:sessions:chrome");
  assert.ok(chrome);
  assert.equal(chrome.commitCount, 3);
  assert.equal(chrome.sessionCount, 2);

  const leaf = model.byId.get("urn:feat:sessions:chrome:download-commits");
  assert.ok(leaf);
  assert.equal(leaf.commitCount, 2);
  assert.equal(leaf.sessionCount, 1);

  const rootTest = model.byId.get("urn:test");
  assert.ok(rootTest);
  assert.equal(rootTest.commitCount, 1);
  assert.equal(rootTest.sessionCount, 1);

  const unk = model.byId.get("__unknown__");
  assert.ok(unk);
  assert.equal(unk.commitCount, 1);
  assert.equal(unk.sessionCount, 1);
});

test("prefixToBreadcrumb builds a clickable path", () => {
  const crumbs = prefixToBreadcrumb("urn:feat:sessions:chrome");
  assert.deepEqual(crumbs.map((c) => c.id), ["__all__", "urn:feat", "urn:feat:sessions", "urn:feat:sessions:chrome"]);
  assert.deepEqual(crumbs.map((c) => c.label), ["All", "urn:feat", "sessions", "chrome"]);
});

test("matchesUrnPrefix matches canonical urn prefixes safely", () => {
  assert.equal(matchesUrnPrefix("urn:feat:sessions:chrome:download", "urn:feat:sessions"), true);
  assert.equal(matchesUrnPrefix("urn:feat:sessionsX", "urn:feat:sessions"), false);
});

if (process.exitCode) process.exit(process.exitCode);
console.log("All tree unit tests passed.");
