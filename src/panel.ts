import { parseQuery, commitMatches, sessionMatchesWithoutCommits, type CommitRec, type SessionRec } from "./lib/query.js";
import { formatLocal, localDateKey } from "./lib/util.js";
import { getSync, setSync } from "./lib/storage.js";
import { buildUrnContainerTree, matchesUrnPrefix, prefixToBreadcrumb, ancestorsInclusive, type TreeModel, type TreeNode } from "./lib/tree.js";

const LOCAL_SESSIONS = "sessions";
const LOCAL_COMMITS = "commits";
const LOCAL_UI = "ui";
const LOCAL_BACKUP_PROOF = "backupProof";

const SYNC_SETTINGS = "settings";

type SyncSettings = {
  urnOnly: boolean;
};

type LocalState = {
  sessions: Record<string, SessionRec>;
  commits: CommitRec[];
  uiQuery: string;
  backupProof: { createdAt: string; hash: string } | null;
  settings: SyncSettings;
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const input = $("q") as HTMLInputElement;
const urnOnlyBox = $("urnOnly") as HTMLInputElement;

const crumbsHost = $("crumbs");
const treeMeta = $("treeMeta");
const sessionsMeta = $("sessionsMeta");
const treeHost = $("tree");
const sessionsHost = $("sessions");

const sheet = $("sheet");
const sheetTitle = $("sheetTitle");
const sheetSub = $("sheetSub");
const sheetHelp = $("sheetHelp");
const commitsHost = $("commits");

let state: LocalState = {
  sessions: {},
  commits: [],
  uiQuery: "",
  backupProof: null,
  settings: { urnOnly: true }
};

let selectedPrefix: string | null = null;
let selectedSessionId: string | null = null;

const collapsed = new Set<string>();
let collapsedInitialized = false;

let showCheat = false;

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

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/g, "");
    const tail = p.split("/").filter(Boolean).slice(-2).join("/");
    return `${u.host}/${tail || ""}`.replace(/\/$/g, "");
  } catch {
    return url;
  }
}

function shortDate(tsIso: string | null | undefined): string {
  const k = localDateKey(tsIso);
  return k || "";
}

function buildNamingContractText(): string {
  // NOTE: Avoid code blocks here; users paste into chat as a short “contract”.
  return [
    "【ファイル命名規約（この拡張がURNツリー化するための契約）】",
    "",
    "前提: この拡張は“ダウンロードファイル名”からURNトークンを抽出してツリー化します。",
    "",
    "必須ルール:",
    "1) ファイル名にURNトークンを必ず含めてください（推奨: 先頭）。",
    "2) 拡張子は必須です（例: .zip / .pdf / .html / .tar.gz）。",
    "   - 多段拡張子も許可します（例: .tar.gz / .jsonl.gz / .zip.crdownload）。",
    "3) Windows等でコロン(:)が使えないため、URNは安全トークン形式で埋め込みます。",
    "4) トークン形式:",
    "   - Feature: urn__feat__<seg1>__<seg2>__...__<leaf>",
    "   - Test:    urn__test__<seg1>__<seg2>__...__<leaf>",
    "   ※ ‘__’ がURNの区切り（:）相当です。",
    "5) segは [a-z0-9_-] のみ（ドット(.) / スペース / 括弧 / 日本語 / 絵文字は不可）。",
    "   - ブラウザが重複ダウンロードで付ける ' (1)' / '(1)' は許可（URNトークンの外側のサフィックスとして扱います）。",
    "   - バージョン表記は v1-2-3 / v1_2_3 のように '.' を使わないでください（例: v0.1.2 は不可）。",
    "6) トークンが無い/無効なファイルはURNツリーに入りません（urn-only ON の場合は記録されません）。",
    "",
    "例）論理URN: urn:feat:sessions:chrome:download-commits",
    "    ファイル名例: urn__feat__sessions__chrome__download-commits.zip"
  ].join("\n");
}

function buildBackupPayload(): { schema: string; exportedAt: string; sessions: Record<string, SessionRec>; commits: CommitRec[] } {
  // Keep deterministic order for readability.
  const sessionsArr = stableSessionsArray(state.sessions);
  const sessions: Record<string, SessionRec> = {};
  for (const s of sessionsArr) sessions[s.id] = s;

  // newest last
  const commits = [...state.commits].sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));

  return {
    schema: "session-download-commits:backup:v1",
    exportedAt: new Date().toISOString(),
    sessions,
    commits
  };
}

async function sha256Hex(inputStr: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(inputStr));
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallthrough
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function runCommand(cmd: string): Promise<void> {
  const c = cmd.toLowerCase();
  if (!c) return;

  if (c === "full") {
    const active = await getActiveTabId();
    await chrome.runtime.sendMessage({ type: "OPEN_FULL_VIEW", returnTabId: active });
    return;
  }

  if (c === "backup") {
    const payload = buildBackupPayload();
    const json = JSON.stringify(payload, null, 2);
    const hash = (await sha256Hex(json)).slice(0, 16);
    const ok = await copyToClipboard(json);
    if (!ok) {
      alert("Clipboardにコピーできませんでした。権限/ポリシーを確認してください。");
      return;
    }
    await chrome.storage.local.set({ [LOCAL_BACKUP_PROOF]: { createdAt: new Date().toISOString(), hash } });
    state.backupProof = { createdAt: new Date().toISOString(), hash };

    const subject = encodeURIComponent(`SessionDL backup ${new Date().toISOString()}`);
    const url = `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}`;
    chrome.tabs.create({ url });
    alert("バックアップJSONをClipboardにコピーしました。Gmailに貼り付けて保存してください。");
    return;
  }

  if (c === "naming" || c === "contract") {
    const text = buildNamingContractText();
    const ok = await copyToClipboard(text);
    if (!ok) {
      alert("Clipboardにコピーできませんでした。権限/ポリシーを確認してください。");
      return;
    }
    alert("命名規約（URNトークン）をClipboardにコピーしました。セッションに貼り付けて使ってください。");
    return;
  }

  if (c === "clear") {
    const proof = state.backupProof;
    if (!proof) {
      alert("clearはブロックされています。先に >backup を実行してください。");
      return;
    }
    await chrome.storage.local.remove([LOCAL_SESSIONS, LOCAL_COMMITS, "pending", LOCAL_UI, "fullReturn", LOCAL_BACKUP_PROOF]);
    selectedPrefix = null;
    selectedSessionId = null;
    await reload();
    render();
    return;
  }

  if (c === "close") {
    await closePanel();
    return;
  }

  alert(`Unknown command: >${cmd}`);
}

async function getActiveTabId(): Promise<number | null> {
  return await new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs: any[]) => {
      const t = tabs && tabs[0];
      resolve(t && typeof t.id === "number" ? t.id : null);
    });
  });
}

async function closePanel(): Promise<void> {
  const win = await new Promise<any>((resolve) => chrome.windows.getCurrent(resolve));
  const windowId = win && typeof win.id === "number" ? win.id : null;
  if (windowId === null) return;
  await chrome.runtime.sendMessage({ type: "CLOSE_PANEL", windowId });
}

async function reload(): Promise<void> {
  const got = await new Promise<any>((resolve) => chrome.storage.local.get([LOCAL_SESSIONS, LOCAL_COMMITS, LOCAL_UI, LOCAL_BACKUP_PROOF], resolve));
  state.sessions = (got[LOCAL_SESSIONS] as Record<string, SessionRec>) || {};
  state.commits = (got[LOCAL_COMMITS] as CommitRec[]) || [];
  state.uiQuery = String((got[LOCAL_UI] && (got[LOCAL_UI] as any).query) || "");
  state.backupProof = (got[LOCAL_BACKUP_PROOF] as any) || null;

  try {
    const gotSync = await getSync<{ [k: string]: unknown }>([SYNC_SETTINGS]);
    const raw = (gotSync[SYNC_SETTINGS] as any) || {};
    state.settings = { urnOnly: raw.urnOnly !== false };
  } catch {
    state.settings = { urnOnly: true };
  }

  urnOnlyBox.checked = state.settings.urnOnly;

  if (document.activeElement !== input) input.value = state.uiQuery;
}

function initCollapsedDefault(model: TreeModel): void {
  if (collapsedInitialized) return;
  for (const n of model.byId.values()) {
    if (n.depth >= 2 && n.children.length > 0) collapsed.add(n.id);
  }
  collapsedInitialized = true;
}

function ensureSelectionVisible(model: TreeModel): void {
  if (!selectedPrefix) return;
  if (!model.byId.has(selectedPrefix)) selectedPrefix = null;
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
      render();
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

function renderTree(model: TreeModel): void {
  treeHost.innerHTML = "";

  if (model.roots.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "コンテナがありません（まだダウンロードがありません）";
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
      render();
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
    showCheat = false;
    selectedPrefix = (selectedPrefix === n.prefix) ? null : n.prefix;
    selectedSessionId = null;
    render();
    scrollNodeIntoView(selectedPrefix);
  });

  treeHost.appendChild(row);

  if (collapsed.has(n.id)) return;
  for (const c of n.children) renderTreeNode(c);
}

function countKnownUrnForSession(sessionId: string): number {
  let n = 0;
  for (const c of state.commits) {
    if (c.sessionId !== sessionId) continue;
    if (c.urn) n += 1;
  }
  return n;
}

function countUnknownUrnForSession(sessionId: string): number {
  let n = 0;
  for (const c of state.commits) {
    if (c.sessionId !== sessionId) continue;
    if (!c.urn) n += 1;
  }
  return n;
}

function renderCommandHint(cmd: string): void {
  sessionsHost.innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty";
  div.innerHTML = `
    <div>Command mode: <span class="kbd">&gt;${escapeHtml(cmd)}</span></div>
    <div style="margin-top:8px;line-height:1.55">
      <div><span class="kbd">&gt;naming</span> 命名規約（URNトークン）をClipboardへコピー</div>
      <div><span class="kbd">&gt;full</span> フル幅ビューを開く（閉じたら戻る）</div>
      <div><span class="kbd">&gt;backup</span> Clipboardコピー → Gmailを開く</div>
      <div><span class="kbd">&gt;clear</span> 先にbackup済みのときのみ全削除</div>
      <div><span class="kbd">&gt;close</span> パネルを閉じる</div>
    </div>`;
  sessionsHost.appendChild(div);
  sheet.classList.remove("open");
}

function render(): void {
  const q = parseQuery(input.value);

  // Build tree from matching commits when searching; hide non-matching containers.
  const treeCommits: CommitRec[] = [];
  if (!q.raw || q.command) {
    treeCommits.push(...state.commits);
  } else {
    for (const c of state.commits) {
      if (!c.sessionId) continue;
      const s = state.sessions[c.sessionId] || null;
      if (!s) continue;
      if (commitMatches(q, c, s)) treeCommits.push(c);
    }
  }
  const includeUnknown = treeCommits.some((c) => !c.urn);
  const model = buildUrnContainerTree(treeCommits, state.sessions, { includeUnknown });

  initCollapsedDefault(model);
  ensureSelectionVisible(model);
  expandSelectionPath(model);

  renderCrumbs();

  // meta
  const uniqSessions = new Set<string>();
  for (const c of treeCommits) if (c.sessionId) uniqSessions.add(c.sessionId);
  treeMeta.textContent = `S:${uniqSessions.size} C:${treeCommits.length}`;

  renderTree(model);

  if (q.command) {
    renderCommandHint(q.command);
    return;
  }

  const sessionsArr = stableSessionsArray(state.sessions);
  const sessionById = state.sessions;

  // Filter commits for sessions list (selection-aware)
  const sessionsFromCommits = new Set<string>();
  for (const c of state.commits) {
    if (!c.sessionId) continue;
    const s = sessionById[c.sessionId] || null;
    if (!s) continue;

    if (selectedPrefix) {
      if (selectedPrefix === "__unknown__") {
        if (c.urn) continue;
      } else {
        if (!c.urn || !matchesUrnPrefix(c.urn, selectedPrefix)) continue;
      }
    }

    if (commitMatches(q, c, s)) sessionsFromCommits.add(c.sessionId);
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

  // Cheat sheet on Ctrl+P
  if (showCheat) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div><strong>Commands</strong> <span class="kbd">Enter</span> to run</div>
        <div class="kbd">type: &gt;cmd</div>
      </div>
      <div style="margin-top:8px;line-height:1.6">
        <div><span class="kbd">&gt;naming</span> 命名規約（URNトークン）をClipboardへコピー</div>
        <div><span class="kbd">&gt;full</span> フル幅ビューを開く（閉じたら戻る）</div>
        <div><span class="kbd">&gt;backup</span> Clipboardコピー → Gmailを開く</div>
        <div><span class="kbd">&gt;clear</span> 先にbackup済みのときのみ全削除</div>
        <div><span class="kbd">&gt;close</span> パネルを閉じる</div>
      </div>
      <div style="margin-top:10px;line-height:1.6">
        <div><strong>Search keys</strong></div>
        <div><span class="kbd">session:chatgpt</span> / <span class="kbd">file:.zip</span> / <span class="kbd">urn:sessions</span></div>
        <div><span class="kbd">on:2026-02-10</span> / <span class="kbd">after:2026-02-01</span> / <span class="kbd">before:2026-02-28</span></div>
        <div><span class="kbd">is:unknown</span>（URNなしのみ）</div>
      </div>`;
    sessionsHost.appendChild(div);
  }

  if (filteredSessions.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = selectedPrefix
      ? `このコンテナ配下で該当なし（検索条件）<br/><span class="kbd">All</span>（パンくず）をクリックしてフィルタ解除できます。`
      : `該当なし`;
    sessionsHost.appendChild(div);
    sessionsMeta.textContent = "shown:0";
    renderSheet(q);
    return;
  }

  sessionsMeta.textContent = `shown:${filteredSessions.length}`;

  for (const s of filteredSessions) {
    const card = document.createElement("div");
    card.className = "card" + (s.id === selectedSessionId ? " selected" : "");
    card.tabIndex = 0;

    const title = s.title || hostFromUrl(s.url);
    const sub = shortUrl(s.url);
    const last = s.lastDownloadAt || s.lastSeenAt || s.createdAt;

    const known = countKnownUrnForSession(s.id);
    const unknown = countUnknownUrnForSession(s.id);

    card.innerHTML = `
      <div class="row">
        <div class="title">${escapeHtml(title)}</div>
      </div>
      <div class="sub">${escapeHtml(sub)}</div>
      <div class="meta">
        <span class="pill"><strong>${s.downloadCount || 0}</strong> commits</span>
        <span class="pill"><strong>${known}</strong> urn</span>
        <span class="pill"><strong>${unknown}</strong> unknown</span>
        <span class="pill">${escapeHtml(formatLocal(last))}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      showCheat = false;
      selectedSessionId = selectedSessionId === s.id ? null : s.id;
      render();
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

  renderSheet(q);
}

function renderSheet(q: ReturnType<typeof parseQuery>): void {
  if (!selectedSessionId) {
    sheet.classList.remove("open");
    return;
  }

  const s = state.sessions[selectedSessionId];
  if (!s) {
    sheet.classList.remove("open");
    return;
  }

  sheet.classList.add("open");
  const title = s.title || hostFromUrl(s.url);

  sheetTitle.textContent = title;
  sheetSub.textContent = s.url;

  sheetHelp.innerHTML = `
    - Click: select / Enter or double-click: open session<br/>
    - Esc: close sheet → Esc again: close panel<br/>
    - Tree selection + search で絞り込み`;

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
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "コミットなし（検索条件に合うものがありません）";
    commitsHost.appendChild(div);
    return;
  }

  for (const c of commits.slice(0, 200)) {
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

async function onQueryChange(): Promise<void> {
  const v = input.value;
  await chrome.runtime.sendMessage({ type: "SET_UI_STATE", query: v });
  render();
}

input.addEventListener("input", () => { showCheat = false; void onQueryChange(); });

urnOnlyBox.addEventListener("change", () => {
  const checked = !!urnOnlyBox.checked;
  state.settings = { ...state.settings, urnOnly: checked };
  void setSync({ [SYNC_SETTINGS]: state.settings });
});

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
    showCheat = true;
    input.focus();
    input.select();
    render();
    return;
  }

  if (ev.key === "Escape") {
    if (selectedSessionId) {
      selectedSessionId = null;
      render();
      return;
    }
    void closePanel();
  }
});

chrome.storage.onChanged.addListener((_changes: any, area: string) => {
  if (area !== "local" && area !== "sync") return;
  void (async () => {
    await reload();
    render();
  })();
});

async function init(): Promise<void> {
  await reload();
  input.value = state.uiQuery;
  render();
}

void init();
