import { localDateKey } from "./util.js";

export type Query = {
  raw: string;
  command: string | null;
  terms: string[];
  sessionTerms: string[];
  fileTerms: string[];
  urnTerms: string[];
  on: string | null;
  after: string | null;
  before: string | null;
  isUnknownUrn: boolean;
};

const SUPPORTED_KEYS = new Set(["session", "file", "urn", "on", "after", "before", "is"]);

function norm(s: string): string {
  return String(s || "").trim().toLowerCase();
}

export function parseQuery(input: string | null | undefined): Query {
  const raw = String(input || "").trim();
  if (!raw) {
    return { raw: "", command: null, terms: [], sessionTerms: [], fileTerms: [], urnTerms: [], on: null, after: null, before: null, isUnknownUrn: false };
  }
  if (raw.startsWith(">")) {
    const cmd = raw.slice(1).trim().split(/\s+/g)[0] || "";
    return { raw, command: cmd.toLowerCase(), terms: [], sessionTerms: [], fileTerms: [], urnTerms: [], on: null, after: null, before: null, isUnknownUrn: false };
  }

  const tokens = raw.split(/\s+/g).filter(Boolean);
  const q: Query = { raw, command: null, terms: [], sessionTerms: [], fileTerms: [], urnTerms: [], on: null, after: null, before: null, isUnknownUrn: false };

  for (const t0 of tokens) {
    const t = t0.trim();
    const idx = t.indexOf(":");
    if (idx > 0) {
      const k = norm(t.slice(0, idx));
      const v = t.slice(idx + 1);
      if (SUPPORTED_KEYS.has(k)) {
        const vv = norm(v);
        if (k === "session") q.sessionTerms.push(vv);
        else if (k === "file") q.fileTerms.push(vv);
        else if (k === "urn") q.urnTerms.push(vv);
        else if (k === "on") q.on = vv || null;
        else if (k === "after") q.after = vv || null;
        else if (k === "before") q.before = vv || null;
        else if (k === "is") {
          if (vv === "unknown" || vv === "unknownurn" || vv === "unknown_urn") q.isUnknownUrn = true;
        }
        continue;
      }
    }
    q.terms.push(norm(t));
  }

  return q;
}

export type SessionRec = {
  id: string;
  url: string;
  title: string | null;
  createdAt: string;
  lastSeenAt: string;
  lastDownloadAt: string | null;
  downloadCount: number;
};

export type CommitRec = {
  id: string;
  sessionId: string | null;
  sessionUrl: string | null;
  capturedAt: string;
  startTime: string | null;
  endTime: string | null;
  state: string | null;
  filename: string | null;
  url: string | null;
  finalUrl: string | null;
  referrer: string | null;
  mime: string | null;
  totalBytes: number | null;
  urn: string | null;
  urnSource: string | null;
};

function includesAny(hay: string, needles: string[]): boolean {
  const hh = hay.toLowerCase();
  for (const n of needles) {
    if (!n) continue;
    if (hh.includes(n)) return true;
  }
  return needles.length === 0;
}

function dateOk(q: Query, tsIso: string | null | undefined): boolean {
  const dk = localDateKey(tsIso);
  if (!dk) return q.on === null && q.after === null && q.before === null;
  if (q.on && dk !== q.on) return false;
  if (q.after && dk < q.after) return false;
  if (q.before && dk > q.before) return false;
  return true;
}

export function commitMatches(q: Query, commit: CommitRec, session: SessionRec | null): boolean {
  if (q.isUnknownUrn && commit.urn) return false;
  if (!dateOk(q, commit.capturedAt || commit.startTime)) return false;

  const sessHay = `${session?.title || ""} ${session?.url || ""}`.trim();
  if (!includesAny(sessHay, q.sessionTerms)) return false;

  const fileHay = `${commit.filename || ""} ${commit.url || ""} ${commit.finalUrl || ""} ${commit.mime || ""}`.trim();
  if (!includesAny(fileHay, q.fileTerms)) return false;

  const urnHay = `${commit.urn || ""}`.trim().toLowerCase();
  if (!includesAny(urnHay, q.urnTerms)) return false;

  const allHay = `${sessHay} ${fileHay} ${urnHay}`.trim().toLowerCase();
  if (!includesAny(allHay, q.terms)) return false;

  return true;
}

export function sessionMatchesWithoutCommits(q: Query, s: SessionRec): boolean {
  const sessHay = `${s.title || ""} ${s.url || ""}`.trim().toLowerCase();
  if (!includesAny(sessHay, q.sessionTerms)) return false;

  const allHay = sessHay;
  if (!includesAny(allHay, q.terms)) return false;

  // If query needs commit-level filters, session-only match is not enough.
  const needsCommits = q.fileTerms.length > 0 || q.urnTerms.length > 0 || q.on !== null || q.after !== null || q.before !== null || q.isUnknownUrn;
  if (needsCommits) return false;

  return true;
}
