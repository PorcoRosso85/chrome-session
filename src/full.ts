import { parseQuery, commitMatches, sessionMatchesWithoutCommits, type CommitRec, type SessionRec } from "./lib/query.js";
import { formatLocal, localDateKey } from "./lib/util.js";
import { buildUrnContainerTree, matchesUrnPrefix, prefixToBreadcrumb, ancestorsInclusive, type TreeModel, type TreeNode } from "./lib/tree.js";

const LOCAL_SESSIONS = "sessions";
const LOCAL_COMMITS = "commits";
const LOCAL_UI = "ui";

type LocalState = {
  sessions: Record<string, SessionRec>;
  commits: CommitRec[];
  uiQuery: string;
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const input = $("q") as HTMLInputElement;
const crumbsHost = $("crumbs");
const treeHost = $("tree");
const sessionsHost = $("sessions");
const detailsHost = $("details");
const commitsHost = $("commits");

let state: LocalState = { sessions: {}, commits: [], uiQuery: "" };

let selectedPrefix: string | null = null; // urn prefix or "__unknown__"
let selectedSessionId: string | null = null;

const collapsed = new Set<string>();
let collapsedInitialized = false;

function stableSessionsArray(sessions: Record<string, SessionRec>): SessionRec[] {
  return Object.values(sessions).sort((a, b) => {
    const ta = a.lastDownloadAt || a.lastSeenAt || a.createdAt;
    const tb = b.lastDownloadAt || b.lastSeenAt || b.createdAt;
    return String(tb).localeCompare(String(ta));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>\"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c] || c));
}

function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function isHttp(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function shortDate(tsIso: string | null | undefined): string {
  const k = localDateKey(tsIso);
  return k || "";
}

function initCollapsedDefault(model: TreeModel): void {
  if (collapsedInitialized) return;
  // Default: keep depth>=2 collapsed to stay compact.
  for (const n of model.byId.values()) {
    if (n.depth >= 2 && n.children.length > 0) collapsed.add(n.id);
  }
  collapsedInitialized = true;
}

function ensureSelectionVisible(model: TreeModel): void {
  if (!selectedPrefix) return;
  if (!model.byId.has(selectedPrefix)) {
    selectedPrefix = null;
    selectedSessionId = null;
  }
}

function expandSelectionPath(model: TreeModel): void {
  if (!selectedPrefix) return;
  const path = ancestorsInclusive(model, selectedPrefix);
  for (const id of path) collapsed.delete(id);
}

function scrollNodeIntoView(prefix: string | null): void {
  if (!prefix) return;
  requestAnimationFrame(() => {
    const el = treeHost.querySelector(`[data-node="${CSS.escape(prefix)}"]`) as HTMLElement | null;
    if (el) el.scrollIntoView({ block: "nearest" });
  });
}

function renderCrumbs(): void {
  const crumbs = prefixToBreadcrumb(selectedPrefix);
  crumbsHost.innerHTML = "";
  const activeId = selectedPrefix || "__all__";

  for (let i = 0; i < crumbs.length; i += 1) {
    const c = crumbs[i];
    const span = document.createElement("span");
    span.className = "crumb" + (c.id === activeId ? " active" : "");
    span.textContent = c.label;
    span.addEventListener("click", () => {
      if (c.id === "__all__") selectedPrefix = null;
      else selectedPrefix = c.id;
      selectedSessionId = null;
      renderAll();
      scrollNodeIntoView(selectedPrefix);
    });
    crumbsHost.appendChild(span);
    if (i < crumbs.length - 1) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "›";
      crumbsHost.appendChild(sep);
    }
  }
}

function renderTreeForQuery(): void {
  const q = parseQuery(input.value);

  // Build tree from matching commits when searching; hide non-matching containers.
  const baseCommits: CommitRec[] = [];
  if (!q.raw || q.command) {
    baseCommits.push(...state.commits);
  } else {
    for (const c of state.commits) {
      if (!c.sessionId) continue;
      const s = state.sessions[c.sessionId] || null;
      if (!s) continue;
      if (commitMatches(q, c, s)) baseCommits.push(c);
    }
  }

  const includeUnknown = baseCommits.some((c) => !c.urn);
  const model = buildUrnContainerTree(baseCommits, state.sessions, { includeUnknown });

  initCollapsedDefault(model);
  ensureSelectionVisible(model);
  expandSelectionPath(model);

  renderCrumbs();

  treeHost.innerHTML = "";
  if (model.roots.length === 0) {
    const div = document.createElement("div");
    div.style.color = "rgba(233,238,245,.55)";
    div.style.fontSize = "12px";
    div.style.lineHeight = "1.45";
    div.textContent = q.raw ? "該当するコンテナがありません（検索条件）" : "まだデータがありません";
    treeHost.appendChild(div);
    return;
  }

  for (const r of model.roots) renderTreeNode(r);
}

function renderTreeNode(n: TreeNode): void {
  const row = document.createElement("div");
  row.className = "trow" + (selectedPrefix === n.prefix ? " selected" : "");
  row.dataset.node = n.prefix;
  row.style.marginLeft = `${n.depth * 10}px`;

  const twisty = document.createElement("button");
  twisty.className = "twisty";
  const hasChildren = n.children.length > 0;
  if (!hasChildren) {
    twisty.textContent = "•";
    twisty.disabled = true;
  } else {
    twisty.textContent = collapsed.has(n.id) ? "▸" : "▾";
    twisty.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (collapsed.has(n.id)) collapsed.delete(n.id);
      else collapsed.add(n.id);
      renderAll();
    });
  }

  const label = document.createElement("div");
  label.className = "tlabel";
  label.textContent = n.depth === 0 ? n.label : n.label;
  label.title = n.prefix;

  const chips = document.createElement("div");
  chips.className = "tchips";
  chips.innerHTML = `
    <span class="chip"><strong>S:${n.sessionCount}</strong></span>
    <span class="chip"><strong>C:${n.commitCount}</strong></span>
    <span class="chip">Last:${escapeHtml(shortDate(n.lastAt))}</span>
  `;

  row.appendChild(twisty);
  row.appendChild(label);
  row.appendChild(chips);

  row.addEventListener("click", () => {
    selectedPrefix = (selectedPrefix === n.prefix) ? null : n.prefix;
    selectedSessionId = null;
    renderAll();
    scrollNodeIntoView(selectedPrefix);
  });

  treeHost.appendChild(row);

  if (collapsed.has(n.id)) return;
  for (const c of n.children) renderTreeNode(c);
}

function renderSessionsAndDetails(): void {
  const q = parseQuery(input.value);
  if (q.command) {
    renderCommandHint(q.command);
    sessionsHost.innerHTML = "";
    commitsHost.innerHTML = "";
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
        if (!c.urn || !matchesUrnPrefix(c.urn, selectedPrefix)) continue;
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
      if (sessionsFromCommits.has(s.id)) filteredSessions.push(s);
    } else {
      if (sessionsFromCommits.has(s.id) || sessionMatchesWithoutCommits(q, s)) filteredSessions.push(s);
    }
  }

  if (selectedSessionId && !filteredSessions.some((s) => s.id === selectedSessionId)) selectedSessionId = null;

  sessionsHost.innerHTML = "";
  if (filteredSessions.length === 0) {
    const div = document.createElement("div");
    div.style.color = "rgba(233,238,245,.55)";
    div.style.fontSize = "12px";
    div.style.lineHeight = "1.45";
    div.textContent = selectedPrefix ? "このコンテナ配下で該当するセッションがありません（検索条件）" : "該当するセッションがありません";
    sessionsHost.appendChild(div);
  } else {
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
        renderSessionsAndDetails();
        renderDetails(q);
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
        if (!c.urn || !matchesUrnPrefix(c.urn, selectedPrefix)) continue;
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
  renderTreeForQuery();
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
