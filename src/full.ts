import { parseQuery, commitMatches, sessionMatchesWithoutCommits, type CommitRec, type SessionRec } from "./lib/query.js";
import { formatLocal } from "./lib/util.js";
import { urnToSegments } from "./lib/urn.js";

const LOCAL_SESSIONS = "sessions";
const LOCAL_COMMITS = "commits";
const LOCAL_UI = "ui";

type LocalState = {
  sessions: Record<string, SessionRec>;
  commits: CommitRec[];
  uiQuery: string;
};

type TreeNode = {
  id: string;
  label: string;
  prefix: string;
  depth: number;
  commitCount: number;
  sessionCount: number;
  children: TreeNode[];
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const input = $("q") as HTMLInputElement;
const treeHost = $("tree");
const sessionsHost = $("sessions");
const detailsHost = $("details");
const commitsHost = $("commits");

let state: LocalState = { sessions: {}, commits: [], uiQuery: "" };

let selectedPrefix: string | null = null; // urn prefix or "__unknown__"
let selectedSessionId: string | null = null;
const collapsed = new Set<string>();

function stableSessionsArray(sessions: Record<string, SessionRec>): SessionRec[] {
  return Object.values(sessions).sort((a, b) => {
    const ta = a.lastDownloadAt || a.lastSeenAt || a.createdAt;
    const tb = b.lastDownloadAt || b.lastSeenAt || b.createdAt;
    return String(tb).localeCompare(String(ta));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c] || c));
}

function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}


function isHttp(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function matchesPrefix(urn: string, prefix: string): boolean {
  if (urn === prefix) return true;
  if (!urn.startsWith(prefix)) return false;
  const ch = urn.slice(prefix.length, prefix.length + 1);
  return ch === ":" || ch === "/" || ch === "";
}

function buildTree(): TreeNode[] {
  const rootFeat: TreeNode = { id: "urn:feat", label: "urn:feat", prefix: "urn:feat", depth: 0, commitCount: 0, sessionCount: 0, children: [] };
  const rootTest: TreeNode = { id: "urn:test", label: "urn:test", prefix: "urn:test", depth: 0, commitCount: 0, sessionCount: 0, children: [] };
  const rootUnknown: TreeNode = { id: "__unknown__", label: "(unknown urn)", prefix: "__unknown__", depth: 0, commitCount: 0, sessionCount: 0, children: [] };

  const byId = new Map<string, TreeNode>();
  byId.set(rootFeat.id, rootFeat);
  byId.set(rootTest.id, rootTest);

  // For counting unique sessions per node:
  const sessionsByNode = new Map<string, Set<string>>();

  function ensureChild(parent: TreeNode, label: string, prefix: string, depth: number): TreeNode {
    const id = prefix;
    let n = byId.get(id);
    if (n) return n;
    n = { id, label, prefix, depth, commitCount: 0, sessionCount: 0, children: [] };
    byId.set(id, n);
    parent.children.push(n);
    return n;
  }

  // Build nodes and counts from commits
  for (const c of state.commits) {
    const sid = c.sessionId;
    if (c.urn) {
      const seg = urnToSegments(c.urn);
      if (!seg) continue;
      const root = seg.root; // "urn:feat" or "urn:test"
      const r = root === "urn:feat" ? rootFeat : rootTest;
      r.commitCount += 1;
      if (sid) {
        if (!sessionsByNode.has(r.id)) sessionsByNode.set(r.id, new Set());
        sessionsByNode.get(r.id)?.add(sid);
      }

      let cur = r;
      let prefix = root;
      for (const s of seg.segments) {
        prefix = `${prefix}:${s}`;
        cur = ensureChild(cur, s, prefix, cur.depth + 1);
        cur.commitCount += 1;
        if (sid) {
          if (!sessionsByNode.has(cur.id)) sessionsByNode.set(cur.id, new Set());
          sessionsByNode.get(cur.id)?.add(sid);
        }
      }
    } else {
      rootUnknown.commitCount += 1;
      if (sid) {
        if (!sessionsByNode.has(rootUnknown.id)) sessionsByNode.set(rootUnknown.id, new Set());
        sessionsByNode.get(rootUnknown.id)?.add(sid);
      }
    }
  }

  // finalize session counts and sort children
  function finalize(n: TreeNode): void {
    n.sessionCount = sessionsByNode.get(n.id)?.size || 0;
    n.children.sort((a, b) => a.label.localeCompare(b.label));
    for (const c of n.children) finalize(c);
  }
  finalize(rootFeat);
  finalize(rootTest);
  finalize(rootUnknown);

  const out: TreeNode[] = [rootFeat, rootTest, rootUnknown].filter((n) => n.commitCount > 0 || n.id !== "__unknown__");
  return out;
}

function renderTree(): void {
  const roots = buildTree();
  treeHost.innerHTML = "";

  for (const r of roots) {
    renderTreeNode(r);
  }
}

function renderTreeNode(n: TreeNode): void {
  const div = document.createElement("div");
  div.className = "treeNode" + (selectedPrefix === n.prefix ? " selected" : "");
  div.style.marginLeft = `${n.depth * 10}px`;

  div.innerHTML = `
    <div class="treeLabel">${escapeHtml(n.depth === 0 ? n.label : n.label)}</div>
    <div class="treeMeta">${escapeHtml(n.prefix)} · commits:${n.commitCount} · sessions:${n.sessionCount}</div>
  `;

  div.addEventListener("click", () => {
    if (selectedPrefix === n.prefix) selectedPrefix = null;
    else selectedPrefix = n.prefix;
    selectedSessionId = null;
    renderAll();
  });

  div.addEventListener("dblclick", () => {
    if (collapsed.has(n.prefix)) collapsed.delete(n.prefix);
    else collapsed.add(n.prefix);
    renderAll();
  });

  treeHost.appendChild(div);

  if (collapsed.has(n.prefix)) return;
  for (const c of n.children) renderTreeNode(c);
}

function renderSessionsAndDetails(): void {
  const q = parseQuery(input.value);
  if (q.command) {
    // Command mode: show nothing special; commands run on Enter.
    renderCommandHint(q.command);
    return;
  }

  const sessionsArr = stableSessionsArray(state.sessions);
  const sessionById = state.sessions;

  const matchingCommits: CommitRec[] = [];
  const sessionsFromCommits = new Set<string>();

  for (const c of state.commits) {
    if (!c.sessionId) continue;
    const s = sessionById[c.sessionId] || null;
    if (!s) continue;

    // tree filter
    if (selectedPrefix) {
      if (selectedPrefix === "__unknown__") {
        if (c.urn) continue;
      } else {
        if (!c.urn || !matchesPrefix(c.urn, selectedPrefix)) continue;
      }
    }

    if (commitMatches(q, c, s)) {
      matchingCommits.push(c);
      sessionsFromCommits.add(c.sessionId);
    }
  }

  const filteredSessions: SessionRec[] = [];
  for (const s of sessionsArr) {
    if (selectedPrefix) {
      // Tree filter implies commit-level matching, sessions must be backed by commits.
      if (sessionsFromCommits.has(s.id)) filteredSessions.push(s);
    } else {
      if (sessionsFromCommits.has(s.id) || sessionMatchesWithoutCommits(q, s)) filteredSessions.push(s);
    }
  }

  if (selectedSessionId && !filteredSessions.some((s) => s.id === selectedSessionId)) selectedSessionId = null;

  sessionsHost.innerHTML = "";
  for (const s of filteredSessions) {
    const card = document.createElement("div");
    card.className = "card" + (s.id === selectedSessionId ? " selected" : "");
    card.tabIndex = 0;

    const title = s.title || hostFromUrl(s.url);
    card.innerHTML = `
      <div class="title">${escapeHtml(title)}</div>
      <div class="sub">${escapeHtml(s.url)}</div>
    `;

    card.addEventListener("click", () => {
      selectedSessionId = selectedSessionId === s.id ? null : s.id;
      renderAll();
    });

    card.addEventListener("dblclick", async () => {
      if (isHttp(s.url)) await chrome.runtime.sendMessage({ type: "FOCUS_OR_OPEN_URL", url: s.url });
    });

    card.addEventListener("keydown", async (ev) => {
      if (ev.key === "Enter") {
        if (isHttp(s.url)) await chrome.runtime.sendMessage({ type: "FOCUS_OR_OPEN_URL", url: s.url });
      }
    });

    sessionsHost.appendChild(card);
  }

  renderDetails(q);
}

function renderDetails(q: ReturnType<typeof parseQuery>): void {
  detailsHost.innerHTML = "";

  if (!selectedSessionId) {
    detailsHost.innerHTML = `<div style="color:rgba(233,238,245,.55);font-size:12px;line-height:1.45">
      セッションをクリックして詳細表示。<br/>
      URNツリーで絞り込みできます。<br/>
      Escで閉じて元のタブに戻ります。
    </div>`;
    commitsHost.innerHTML = "";
    return;
  }

  const s = state.sessions[selectedSessionId];
  if (!s) return;

  const title = s.title || hostFromUrl(s.url);
  detailsHost.innerHTML = `
    <div class="detailsHeader">
      <div class="detailsTitle">${escapeHtml(title)}</div>
      <div class="detailsSub">${escapeHtml(s.url)}</div>
    </div>
  `;

  const commits: CommitRec[] = [];
  for (const c of state.commits) {
    if (c.sessionId !== selectedSessionId) continue;

    if (selectedPrefix) {
      if (selectedPrefix === "__unknown__") {
        if (c.urn) continue;
      } else {
        if (!c.urn || !matchesPrefix(c.urn, selectedPrefix)) continue;
      }
    }

    if (!commitMatches(q, c, s)) continue;
    commits.push(c);
  }
  commits.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));

  commitsHost.innerHTML = "";
  if (commits.length === 0) {
    commitsHost.innerHTML = `<div style="color:rgba(233,238,245,.55);font-size:12px">コミットなし</div>`;
    return;
  }

  for (const c of commits.slice(0, 400)) {
    const div = document.createElement("div");
    div.className = "commit";
    const file = c.filename || "(no filename)";
    const urn = c.urn || "(unknown)";
    const st = c.state || "";
    div.innerHTML = `
      <div class="commitTop">
        <div class="commitFile">${escapeHtml(file)}</div>
        <div class="commitTime">${escapeHtml(formatLocal(c.capturedAt || c.startTime))}</div>
      </div>
      <div class="commitMeta">
        <span class="pill"><strong>${escapeHtml(st)}</strong></span>
        <span class="pill">${escapeHtml(urn)}</span>
      </div>
    `;
    commitsHost.appendChild(div);
  }
}

function renderCommandHint(cmd: string): void {
  detailsHost.innerHTML = `<div style="color:rgba(233,238,245,.55);font-size:12px;line-height:1.55">
    Command mode: <span class="kbd">&gt;${escapeHtml(cmd)}</span><br/>
    - <span class="kbd">&gt;close</span> このタブを閉じて戻る
  </div>`;
}

async function runCommand(cmd: string): Promise<void> {
  const c = cmd.toLowerCase();
  if (c === "close") {
    await closeSelf();
    return;
  }
  alert(`Unknown command: >${cmd}`);
}

async function closeSelf(): Promise<void> {
  const tabId = await new Promise<number | null>((resolve) => {
    chrome.tabs.getCurrent((t: any) => resolve(t && typeof t.id === "number" ? t.id : null));
  });
  if (tabId === null) {
    window.close();
    return;
  }
  await chrome.runtime.sendMessage({ type: "CLOSE_FULL_VIEW", fullTabId: tabId });
}

async function reload(): Promise<void> {
  const got = await new Promise<any>((resolve) => chrome.storage.local.get([LOCAL_SESSIONS, LOCAL_COMMITS, LOCAL_UI], resolve));
  state.sessions = (got[LOCAL_SESSIONS] as Record<string, SessionRec>) || {};
  state.commits = (got[LOCAL_COMMITS] as CommitRec[]) || [];
  state.uiQuery = String((got[LOCAL_UI] && (got[LOCAL_UI] as any).query) || "");
  if (document.activeElement !== input) input.value = state.uiQuery;
}

function renderAll(): void {
  renderTree();
  renderSessionsAndDetails();
}

async function onQueryChange(): Promise<void> {
  const v = input.value;
  await chrome.runtime.sendMessage({ type: "SET_UI_STATE", query: v });
  renderAll();
}

input.addEventListener("input", () => { void onQueryChange(); });

input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    const q = parseQuery(input.value);
    if (q.command) {
      ev.preventDefault();
      void runCommand(q.command);
    }
  }
});

window.addEventListener("keydown", (ev) => {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mod = isMac ? ev.metaKey : ev.ctrlKey;

  if (mod && ev.key.toLowerCase() === "p") {
    ev.preventDefault();
    input.focus();
    input.select();
    return;
  }

  if (ev.key === "Escape") {
    if (selectedSessionId) {
      selectedSessionId = null;
      renderAll();
      return;
    }
    void closeSelf();
  }
});

chrome.storage.onChanged.addListener((_changes: any, area: string) => {
  if (area !== "local") return;
  void (async () => {
    await reload();
    renderAll();
  })();
});

async function init(): Promise<void> {
  await reload();
  input.value = state.uiQuery;
  renderAll();
}

void init();
