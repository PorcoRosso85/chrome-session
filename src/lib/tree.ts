import { type CommitRec, type SessionRec } from "./query.js";
import { urnToSegments } from "./urn.js";

export type TreeNode = {
  id: string;        // stable id == prefix
  label: string;     // segment label (root uses full label like 'urn:feat')
  prefix: string;    // canonical urn prefix (or '__unknown__')
  depth: number;     // root=0
  commitCount: number;
  sessionCount: number;
  lastAt: string | null; // ISO timestamp
  children: TreeNode[];
};

export type TreeModel = {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
  parentById: Map<string, string | null>;
};

export type BuildTreeOpts = {
  includeUnknown?: boolean;
};

export function matchesUrnPrefix(urn: string, prefix: string): boolean {
  if (urn === prefix) return true;
  if (!urn.startsWith(prefix)) return false;
  const ch = urn.slice(prefix.length, prefix.length + 1);
  return ch === ":" || ch === "/" || ch === "";
}

export function buildUrnContainerTree(
  commits: CommitRec[],
  sessionsById: Record<string, SessionRec>,
  opts?: BuildTreeOpts
): TreeModel {
  const includeUnknown = opts?.includeUnknown === true;

  const rootFeat: TreeNode = { id: "urn:feat", label: "urn:feat", prefix: "urn:feat", depth: 0, commitCount: 0, sessionCount: 0, lastAt: null, children: [] };
  const rootTest: TreeNode = { id: "urn:test", label: "urn:test", prefix: "urn:test", depth: 0, commitCount: 0, sessionCount: 0, lastAt: null, children: [] };
  const rootUnknown: TreeNode = { id: "__unknown__", label: "(unknown urn)", prefix: "__unknown__", depth: 0, commitCount: 0, sessionCount: 0, lastAt: null, children: [] };

  const byId = new Map<string, TreeNode>();
  const parentById = new Map<string, string | null>();

  byId.set(rootFeat.id, rootFeat);
  byId.set(rootTest.id, rootTest);
  parentById.set(rootFeat.id, null);
  parentById.set(rootTest.id, null);

  if (includeUnknown) {
    byId.set(rootUnknown.id, rootUnknown);
    parentById.set(rootUnknown.id, null);
  }

  // Unique sessions per node:
  const sessionsByNode = new Map<string, Set<string>>();
  const lastByNode = new Map<string, string>();

  function bumpLast(nodeId: string, ts: string | null | undefined): void {
    if (!ts) return;
    const cur = lastByNode.get(nodeId);
    if (!cur || String(ts) > cur) lastByNode.set(nodeId, String(ts));
  }

  function bumpSession(nodeId: string, sessionId: string | null): void {
    if (!sessionId) return;
    if (!sessionsById[sessionId]) return;
    let set = sessionsByNode.get(nodeId);
    if (!set) {
      set = new Set<string>();
      sessionsByNode.set(nodeId, set);
    }
    set.add(sessionId);
  }

  function ensureChild(parent: TreeNode, label: string, prefix: string, depth: number): TreeNode {
    const id = prefix;
    const existing = byId.get(id);
    if (existing) return existing;
    const n: TreeNode = { id, label, prefix, depth, commitCount: 0, sessionCount: 0, lastAt: null, children: [] };
    byId.set(id, n);
    parentById.set(id, parent.id);
    parent.children.push(n);
    return n;
  }

  function bumpNode(n: TreeNode, commit: CommitRec): void {
    n.commitCount += 1;
    bumpSession(n.id, commit.sessionId);
    bumpLast(n.id, commit.capturedAt || commit.startTime);
  }

  for (const c of commits) {
    if (c.urn) {
      const seg = urnToSegments(c.urn);
      if (!seg) continue;
      const r = seg.root === "urn:feat" ? rootFeat : rootTest;
      bumpNode(r, c);

      let cur = r;
      let prefix = seg.root;
      for (const s of seg.segments) {
        prefix = `${prefix}:${s}`;
        cur = ensureChild(cur, s, prefix, cur.depth + 1);
        bumpNode(cur, c);
      }
    } else if (includeUnknown) {
      bumpNode(rootUnknown, c);
    }
  }

  function finalize(n: TreeNode): void {
    n.sessionCount = sessionsByNode.get(n.id)?.size || 0;
    n.lastAt = lastByNode.get(n.id) || null;
    n.children.sort((a, b) => a.label.localeCompare(b.label));
    for (const c of n.children) finalize(c);
  }

  finalize(rootFeat);
  finalize(rootTest);
  if (includeUnknown) finalize(rootUnknown);

  const roots: TreeNode[] = [rootFeat, rootTest];
  if (includeUnknown) roots.push(rootUnknown);

  // Drop empty roots
  const kept = roots.filter((r) => r.commitCount > 0);
  return { roots: kept, byId, parentById };
}

export function ancestorsInclusive(model: TreeModel, nodeId: string): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = nodeId;
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur)) break;
    guard.add(cur);
    out.push(cur);
    cur = model.parentById.get(cur) ?? null;
  }
  return out.reverse();
}

export function prefixToBreadcrumb(prefix: string | null): { id: string; label: string }[] {
  if (!prefix) return [{ id: "__all__", label: "All" }];
  if (prefix === "__unknown__") return [{ id: "__all__", label: "All" }, { id: "__unknown__", label: "(unknown)" }];

  const parts = prefix.split(":").filter(Boolean);
  if (parts.length < 2) return [{ id: "__all__", label: "All" }];
  const root = `${parts[0]}:${parts[1]}`;
  const segs = parts.slice(2);

  const crumbs: { id: string; label: string }[] = [{ id: "__all__", label: "All" }, { id: root, label: root }];
  let p = root;
  for (const s of segs) {
    p = `${p}:${s}`;
    crumbs.push({ id: p, label: s });
  }
  return crumbs;
}
