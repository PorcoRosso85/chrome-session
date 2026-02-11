export type UrnExtract = { urn: string | null; source: string | null };

function trimPunctuation(s: string): string {
  return s.replace(/[)\]}>,.]+$/g, "").replace(/^[<[{(]+/g, "");
}

export function normalizeUrnCandidate(s: string): string | null {
  const t = trimPunctuation(String(s || "").trim());
  if (!t) return null;

  const lower = t.toLowerCase();

  // Allowlist: urn:feat:* or urn:test:*
  const m = lower.match(/^urn:(feat|test):(.+)$/);
  if (!m) return null;

  const ns = m[1];
  const rest = m[2];

  // Accept either ':' or '/' as separators, but normalize to ':'.
  const segs = rest.split(/[:/]+/g).filter(Boolean);
  if (segs.length === 0) return null;

  // Strict segments: alnum + (- or _). No dots/spaces/parentheses.
  const segRe = /^[a-z0-9][a-z0-9_-]*$/;
  for (const seg of segs) {
    if (!segRe.test(seg)) return null;
  }

  return `urn:${ns}:${segs.join(":")}`;
}

function decodePercentIfAny(s: string): string {
  try {
    // Only decode if it looks encoded, to avoid throwing on "%" used as literal.
    return s.includes("%3A") || s.includes("%3a") ? decodeURIComponent(s) : s;
  } catch {
    return s;
  }
}

function baseName(filename: string): string {
  const parts = filename.split(/[\\/]/g);
  return parts[parts.length - 1] || filename;
}

function isTokenChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

function isEncodedTokenChar(ch: string): boolean {
  return /[A-Za-z0-9%_-]/.test(ch);
}

function isRawUrnChar(ch: string): boolean {
  return /[A-Za-z0-9:_/-]/.test(ch);
}

function takePrefix(s: string, isOk: (ch: string) => boolean): { token: string; rest: string } | null {
  let i = 0;
  while (i < s.length && isOk(s[i] || "")) i += 1;
  if (i <= 0) return null;
  return { token: s.slice(0, i), rest: s.slice(i) };
}

// Suffix allowlist after the URN token.
// - optional duplicate marker: " (1)" or "(1)"
// - extension is required
// - multi-extension is allowed: .tar.gz / .zip.crdownload / .jsonl.gz
// NOTE: each extension segment must start with a letter to avoid mis-parsing version dots (e.g. v0.1.2)
const SUFFIX_RE = /^\s*(\(\d+\))?\s*(\.[A-Za-z][A-Za-z0-9_-]{0,15}){1,3}\s*$/;

export function extractUrnFromFilename(filename: string | null | undefined): UrnExtract {
  if (!filename) return { urn: null, source: null };
  const bn = baseName(String(filename));

  // 1) URL-encoded urn%3Afeat%3A...
  const encIdx = bn.toLowerCase().indexOf("urn%3a");
  if (encIdx >= 0) {
    const sub = bn.slice(encIdx);
    const p = takePrefix(sub, isEncodedTokenChar);
    if (p && SUFFIX_RE.test(p.rest)) {
      const decoded = decodePercentIfAny(p.token);
      const urn = normalizeUrnCandidate(decoded);
      if (urn) return { urn, source: "filename:urn%3A" };
    }
  }

  // 2) Double-underscore safe token: urn__feat__a__b -> urn:feat:a:b
  const duIdx = bn.toLowerCase().indexOf("urn__feat__");
  const duIdx2 = bn.toLowerCase().indexOf("urn__test__");
  const duStart = duIdx >= 0 ? duIdx : (duIdx2 >= 0 ? duIdx2 : -1);
  if (duStart >= 0) {
    const sub = bn.slice(duStart);
    const p = takePrefix(sub, isTokenChar);
    if (p && SUFFIX_RE.test(p.rest)) {
      const decoded = p.token.replace(/__/g, ":");
      const urn = normalizeUrnCandidate(decoded);
      if (urn) return { urn, source: "filename:urn__" };
    }
  }

  // 3) Single-underscore legacy: urn_feat_a_b -> urn:feat:a:b
  const suIdx = bn.toLowerCase().indexOf("urn_feat_");
  const suIdx2 = bn.toLowerCase().indexOf("urn_test_");
  const suStart = suIdx >= 0 ? suIdx : (suIdx2 >= 0 ? suIdx2 : -1);
  if (suStart >= 0) {
    const sub = bn.slice(suStart);
    const p = takePrefix(sub, isTokenChar);
    if (p && SUFFIX_RE.test(p.rest)) {
      const decoded = p.token
        .replace(/^urn_feat_/, "urn:feat:")
        .replace(/^urn_test_/, "urn:test:")
        .replace(/_/g, ":");
      const urn = normalizeUrnCandidate(decoded);
      if (urn) return { urn, source: "filename:urn_" };
    }
  }

  // 4) Raw canonical in filename (may survive on mac/linux): urn:feat:...
  const rawIdx = bn.toLowerCase().indexOf("urn:feat:");
  const rawIdx2 = bn.toLowerCase().indexOf("urn:test:");
  const rawStart = rawIdx >= 0 ? rawIdx : (rawIdx2 >= 0 ? rawIdx2 : -1);
  if (rawStart >= 0) {
    const sub = bn.slice(rawStart);
    const p = takePrefix(sub, isRawUrnChar);
    if (p && SUFFIX_RE.test(p.rest)) {
      const urn = normalizeUrnCandidate(p.token);
      if (urn) return { urn, source: "filename:urn:" };
    }
  }

  return { urn: null, source: null };
}

export function urnToSegments(urn: string): { root: string; segments: string[] } | null {
  const u = normalizeUrnCandidate(urn);
  if (!u) return null;
  const parts = u.split(":");
  const root = `${parts[0]}:${parts[1]}`;
  const rest = parts.slice(2).join(":");
  const segs = rest.split(/[:/]+/g).filter(Boolean);
  return { root, segments: segs };
}
