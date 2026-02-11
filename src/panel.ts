import { parseQuery, commitMatches, sessionMatchesWithoutCommits, type CommitRec, type SessionRec } from "./lib/query.js";
import { formatLocal } from "./lib/util.js";
import { getSync, setSync } from "./lib/storage.js";

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
const list = $("list");
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

let selectedSessionId: string | null = null;

let showCheat = false;

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
  // Try modern API first.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallthrough
  }

  // Fallback: execCommand('copy')
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

    // Open Gmail compose (no body; paste manually)
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
    alert("命名規約（URNトークン）をClipboardにコピーしました。セッションに貼り付けて使ってください。\n\nCommand: >naming");
    return;
  }

  if (c === "clear") {
    const proof = state.backupProof;
    if (!proof) {
      alert("clearはブロックされています。先に >backup を実行してください。");
      return;
    }
    // Clear only our keys.
    await chrome.storage.local.remove([LOCAL_SESSIONS, LOCAL_COMMITS, "pending", LOCAL_UI, "fullReturn", LOCAL_BACKUP_PROOF]);
    selectedSessionId = null;
    await reload();
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

  // Settings are small and safe to sync.
  try {
    const gotSync = await getSync<{ [k: string]: unknown }>([SYNC_SETTINGS]);
    const raw = (gotSync[SYNC_SETTINGS] as any) || {};
    state.settings = { urnOnly: raw.urnOnly !== false };
  } catch {
    state.settings = { urnOnly: true };
  }

  urnOnlyBox.checked = state.settings.urnOnly;

  // Keep input in sync unless the user is typing.
  if (document.activeElement !== input) input.value = state.uiQuery;
}

function render(): void {
  const q = parseQuery(input.value);
  if (q.command) {
    renderCommandHint(q.command);
    return;
  }

  const sessionsArr = stableSessionsArray(state.sessions);
  const sessionById = state.sessions;

  // Filter commits first (for commit-level filters)
  const matchingCommits: CommitRec[] = [];
  const sessionsFromCommits = new Set<string>();
  for (const c of state.commits) {
    if (!c.sessionId) continue;
    const s = sessionById[c.sessionId] || null;
    if (!s) continue;
    if (commitMatches(q, c, s)) {
      matchingCommits.push(c);
      sessionsFromCommits.add(c.sessionId);
    }
  }

  const filteredSessions: SessionRec[] = [];
  for (const s of sessionsArr) {
    if (sessionsFromCommits.has(s.id) || sessionMatchesWithoutCommits(q, s)) {
      filteredSessions.push(s);
    }
  }

  // If current selection is no longer visible, close sheet.
  if (selectedSessionId && !filteredSessions.some((s) => s.id === selectedSessionId)) {
    selectedSessionId = null;
  }

  list.innerHTML = "";
  if (showCheat) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div><strong>Command palette</strong> <span class="kbd">Enter</span> to run</div>
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
        <div><strong>Search keys</strong>（スペース区切りで複数指定可）</div>
        <div><span class="kbd">session:chatgpt</span> / <span class="kbd">file:.zip</span> / <span class="kbd">urn:sessions</span></div>
        <div><span class="kbd">on:2026-02-10</span> / <span class="kbd">after:2026-02-01</span> / <span class="kbd">before:2026-02-28</span></div>
        <div><span class="kbd">is:unknown</span>（URNなしのみ）</div>
      </div>`;
    list.appendChild(div);
  }
  if (filteredSessions.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `
      <div>該当なし</div>
      <div style="margin-top:6px">
        - ダウンロードすると自動でセッションが作成されます<br/>
        - Ctrl+P で検索<br/>
        - <span class="kbd">&gt;naming</span> で命名規約をClipboardへコピー<br/>
        - <span class="kbd">&gt;full</span> でフル幅ビュー<br/>
        - <span class="kbd">&gt;backup</span> でGmailバックアップ
      </div>`;
    list.appendChild(div);
  } else {
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
        if (selectedSessionId === s.id) {
          selectedSessionId = null;
        } else {
          selectedSessionId = s.id;
        }
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

      list.appendChild(card);
    }
  }

  renderSheet(q);
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
  list.innerHTML = "";
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
  list.appendChild(div);

  sheet.classList.remove("open");
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
    - 検索はセッション/ファイル/URN/日付で絞り込み可能`;

  const commits: CommitRec[] = [];
  for (const c of state.commits) {
    if (c.sessionId !== selectedSessionId) continue;
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
    // 1st Esc: close sheet if open; 2nd: close panel
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

  // Initial render
  render();
}

void init();
