import assert from "node:assert/strict";

// NOTE: This script runs after `tsc`, so it imports from dist/.
import { extractUrnFromFilename, normalizeUrnCandidate } from "../dist/lib/urn.js";

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

test("normalizeUrnCandidate rejects non-urn", () => {
  assert.equal(normalizeUrnCandidate("hello"), null);
});

test("normalizeUrnCandidate canonicalizes and validates segments", () => {
  assert.equal(normalizeUrnCandidate("urn:feat:sessions:chrome:download-commits"), "urn:feat:sessions:chrome:download-commits");
  assert.equal(normalizeUrnCandidate("URN:FEAT:sessions/chrome/download-commits"), "urn:feat:sessions:chrome:download-commits");
  assert.equal(normalizeUrnCandidate("urn:feat:bad.seg"), null);
  assert.equal(normalizeUrnCandidate("urn:feat:bad seg"), null);
  assert.equal(normalizeUrnCandidate("urn:feat:bad(seg)"), null);
});

test("extractUrnFromFilename supports urn__ double-underscore token", () => {
  const r = extractUrnFromFilename("urn__feat__sessions__chrome__download-commits.zip");
  assert.equal(r.urn, "urn:feat:sessions:chrome:download-commits");
  assert.equal(r.source, "filename:urn__");
});

test("extractUrnFromFilename supports legacy urn_feat single-underscore token", () => {
  const r = extractUrnFromFilename("urn_feat_sessions_chrome_download-commits.zip");
  assert.equal(r.urn, "urn:feat:sessions:chrome:download-commits");
  assert.equal(r.source, "filename:urn_");
});

test("extractUrnFromFilename supports url-encoded token", () => {
  const r = extractUrnFromFilename("urn%3Afeat%3Asessions%3Achrome%3Adownload-commits.zip");
  assert.equal(r.urn, "urn:feat:sessions:chrome:download-commits");
  assert.equal(r.source, "filename:urn%3A");
});

test("extractUrnFromFilename accepts multi-extension (.tar.gz)", () => {
  const r = extractUrnFromFilename("urn__feat__spec-oracle__lean__python__shift-left__code-only-v2.tar.gz");
  assert.equal(r.urn, "urn:feat:spec-oracle:lean:python:shift-left:code-only-v2");
});

test("extractUrnFromFilename accepts duplicate suffix (1)", () => {
  const r = extractUrnFromFilename("urn__feat__spec-oracle__lean__python__shift-left__code-only-v2 (1).tar.gz");
  assert.equal(r.urn, "urn:feat:spec-oracle:lean:python:shift-left:code-only-v2");
});

test("extractUrnFromFilename accepts temporary .crdownload multi-extension", () => {
  const r = extractUrnFromFilename("urn__feat__sessions__chrome__download-commits.zip.crdownload");
  assert.equal(r.urn, "urn:feat:sessions:chrome:download-commits");
});

test("extractUrnFromFilename rejects version dots (v0.1.2)", () => {
  const r = extractUrnFromFilename("urn__feat__sessions__chrome__download-commits-v0.1.2.zip");
  assert.equal(r.urn, null);
});

if (process.exitCode) process.exit(process.exitCode);
console.log("All unit tests passed.");
