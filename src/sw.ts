import { getLocal, setLocal, getSync, setSync } from "./lib/storage.js";
import { canonicalizeUrl, isHttpUrl, nowIso, sha256Hex } from "./lib/util.js";
import { extractUrnFromFilename } from "./lib/urn.js";

type SessionRec = {
  id: string;
  url: string;
  title: string | null;
  createdAt: string;
  lastSeenAt: string;
  lastDownloadAt: string | null;
  downloadCount: number;
};

type CommitRec = {
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

type PendingRec = {
  id: string;
  createdAt: string;
  sessionUrl: string | null;
  sessionTitle: string | null;
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
};

type LocalState = {
  sessions: Record<string, SessionRec>;
  commits: CommitRec[];
  pending: Record<string, PendingRec>;
};

const LOCAL_SESSIONS = "sessions";
const LOCAL_COMMITS = "commits";
const LOCAL_PENDING = "pending";
const LOCAL_UI = "ui";
const LOCAL_FULL_RETURN = "fullReturn";

const SYNC_SETTINGS = "settings";

type SyncSettings = {
  urnOnly: boolean;
};

const MAX_COMMITS = 5000;

const MAX_PENDING_AGE_MS = 1000 * 60 * 60 * 24 * 2; // 48h best-effort cleanup

function prunePending(state: LocalState): void {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of Object.entries(state.pending)) {
    const t = Date.parse(p.createdAt || "");
    if (!Number.isFinite(t)) continue;
    if (now - t > MAX_PENDING_AGE_MS) {
      delete state.pending[id];
      changed = true;
    }
  }
  if (changed) {
    // no-op; caller will save
  }
}

async function loadSettings(): Promise<SyncSettings> {
  const got = await getSync<{ [k: string]: unknown }>([SYNC_SETTINGS]);
  const raw = (got[SYNC_SETTINGS] as any) || {};
  // Default: urn-only ON (record only downloads whose filename includes an URN token)
  const urnOnly = raw.urnOnly !== false;
  return { urnOnly };
}

async function ensureSettingsDefaults(): Promise<void> {
  try {
    const got = await getSync<{ [k: string]: unknown }>([SYNC_SETTINGS]);
    if (!got || typeof (got as any)[SYNC_SETTINGS] !== "object") {
      await setSync({ [SYNC_SETTINGS]: { urnOnly: true } });
      return;
    }
    const cur = ((got as any)[SYNC_SETTINGS] || {}) as any;
    if (typeof cur.urnOnly !== "boolean") {
      await setSync({ [SYNC_SETTINGS]: { ...cur, urnOnly: true } });
    }
  } catch (e) {
    // best-effort
    console.warn("ensureSettingsDefaults failed", e);
  }
}

let lock: Promise<void> = Promise.resolve();

function withLock(fn: () => Promise<void>): Promise<void> {
  lock = lock.then(fn).catch((err) => console.error("op failed", err));
  return lock;
}

async function loadState(): Promise<LocalState> {
  const got = await getLocal<{ [k: string]: unknown }>([LOCAL_SESSIONS, LOCAL_COMMITS, LOCAL_PENDING]);
  const sessions = (got[LOCAL_SESSIONS] as Record<string, SessionRec>) || {};
  const commits = (got[LOCAL_COMMITS] as CommitRec[]) || [];
  const pending = (got[LOCAL_PENDING] as Record<string, PendingRec>) || {};
  return { sessions, commits, pending };
}

async function saveState(state: LocalState): Promise<void> {
  await setLocal({ [LOCAL_SESSIONS]: state.sessions, [LOCAL_COMMITS]: state.commits, [LOCAL_PENDING]: state.pending });
}

async function ensureSession(url: string, title: string | null, state: LocalState): Promise<SessionRec> {
  const canon = canonicalizeUrl(url);
  const hex = await sha256Hex(canon);
  const id = hex.slice(0, 12);

  const now = nowIso();
  const existing = state.sessions[id];
  if (existing) {
    const next: SessionRec = {
      ...existing,
      url: canon,
      title: title || existing.title,
      lastSeenAt: now
    };
    state.sessions[id] = next;
    return next;
  }

  const created: SessionRec = {
    id,
    url: canon,
    title,
    createdAt: now,
    lastSeenAt: now,
    lastDownloadAt: null,
    downloadCount: 0
  };
  state.sessions[id] = created;
  return created;
}

async function addCommit(commit: CommitRec, state: LocalState): Promise<void> {
  // upsert commit by id
  const idx = state.commits.findIndex((c) => c.id === commit.id);
  if (idx >= 0) state.commits[idx] = { ...state.commits[idx], ...commit };
  else state.commits.push(commit);

  // keep newest last; trim if needed
  if (state.commits.length > MAX_COMMITS) state.commits = state.commits.slice(state.commits.length - MAX_COMMITS);
}

async function updateSessionStats(sessionId: string, state: LocalState): Promise<void> {
  const s = state.sessions[sessionId];
  if (!s) return;
  const now = nowIso();
  state.sessions[sessionId] = {
    ...s,
    lastDownloadAt: now,
    downloadCount: (s.downloadCount || 0) + 1,
    lastSeenAt: now
  };
}

async function pickActiveTab(): Promise<{ id: number; windowId: number; url: string | null; title: string | null } | null> {
  return await new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs: any[]) => {
      const t = tabs && tabs[0];
      if (!t || typeof t.id !== "number") return resolve(null);
      resolve({ id: t.id, windowId: t.windowId, url: t.url || null, title: t.title || null });
    });
  });
}

async function focusOrOpen(url: string): Promise<void> {
  const canon = canonicalizeUrl(url);
  if (!isHttpUrl(canon)) return;
  await new Promise<void>((resolve) => {
    chrome.tabs.query({}, (tabs: any[]) => {
      const hit = (tabs || []).find((t) => typeof t.url === "string" && canonicalizeUrl(t.url) === canon);
      if (hit && typeof hit.id === "number") {
        chrome.tabs.update(hit.id, { active: true }, () => {
          chrome.windows.update(hit.windowId, { focused: true }, () => resolve());
        });
        return;
      }
      chrome.tabs.create({ url: canon }, () => resolve());
    });
  });
}

async function maybeSyncSessionsIndex(sessions: Record<string, SessionRec>): Promise<void> {
  // Sync is best-effort. Keep minimal payload.
  const index: Record<string, { id: string; url: string; title: string | null; lastSeenAt: string; lastDownloadAt: string | null; downloadCount: number }> = {};
  for (const [id, s] of Object.entries(sessions)) {
    index[id] = { id, url: s.url, title: s.title, lastSeenAt: s.lastSeenAt, lastDownloadAt: s.lastDownloadAt, downloadCount: s.downloadCount };
  }
  try {
    await setSync({ sessionsIndex: index });
  } catch (e) {
    console.warn("sync failed", e);
  }
}

function hasSidePanelApi(): boolean {
  return !!(chrome && chrome.sidePanel && typeof chrome.sidePanel.open === "function");
}


async function openPanelForWindow(windowId: number): Promise<void> {
  if (!hasSidePanelApi()) return;
  try {
    await chrome.sidePanel.open({ windowId });
  } catch (e) {
    console.warn("sidePanel.open failed", e);
  }
}

async function closePanelForWindow(windowId: number): Promise<void> {
  if (!hasSidePanelApi()) return;
  const sp = chrome.sidePanel;
  if (sp && typeof sp.close === "function") {
    try {
      await sp.close({ windowId });
      return;
    } catch (e) {
      // Fallback below
      console.warn("sidePanel.close failed", e);
    }
  }
  try {
    // Fallback: disable then re-enable default. (May behave differently based on tab-specific settings.)
    await sp.setOptions({ enabled: false });
    await sp.setOptions({ enabled: true });
  } catch (e) {
    console.warn("sidePanel fallback close failed", e);
  }
}


chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn("setPanelBehavior failed", e);
  }

  // Default settings (best-effort)
  void ensureSettingsDefaults();
});


chrome.action.onClicked.addListener(async (tab: any) => {
  if (tab && typeof tab.windowId === "number") {
    await openPanelForWindow(tab.windowId);
  }
});


chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (v?: any) => void) => {
  (async () => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "FOCUS_OR_OPEN_URL" && typeof msg.url === "string") {
      await focusOrOpen(msg.url);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "OPEN_FULL_VIEW") {
      const returnTabId = typeof msg.returnTabId === "number" ? msg.returnTabId : null;
      const url = chrome.runtime.getURL("full.html");
      chrome.tabs.create({ url }, async (tab: any) => {
        if (tab && typeof tab.id === "number") {
          const fullTabId = tab.id;
          const got = await getLocal<{ [k: string]: unknown }>([LOCAL_FULL_RETURN]);
          const map = (got[LOCAL_FULL_RETURN] as Record<string, number>) || {};
          if (returnTabId !== null) map[String(fullTabId)] = returnTabId;
          await setLocal({ [LOCAL_FULL_RETURN]: map });
        }
        sendResponse({ ok: true });
      });
      return;
    }

    if (msg.type === "CLOSE_FULL_VIEW") {
      const fullTabId = typeof msg.fullTabId === "number" ? msg.fullTabId : null;
      if (fullTabId === null) return;
      const got = await getLocal<{ [k: string]: unknown }>([LOCAL_FULL_RETURN]);
      const map = (got[LOCAL_FULL_RETURN] as Record<string, number>) || {};
      const returnTabId = map[String(fullTabId)];
      delete map[String(fullTabId)];
      await setLocal({ [LOCAL_FULL_RETURN]: map });

      chrome.tabs.remove(fullTabId, () => {
        if (typeof returnTabId === "number") {
          chrome.tabs.update(returnTabId, { active: true }, () => sendResponse({ ok: true }));
        } else {
          sendResponse({ ok: true });
        }
      });
      return;
    }

    if (msg.type === "CLOSE_PANEL" && typeof msg.windowId === "number") {
      await closePanelForWindow(msg.windowId);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SET_UI_STATE" && typeof msg.query === "string") {
      await setLocal({ [LOCAL_UI]: { query: msg.query } });
      sendResponse({ ok: true });
      return;
    }
  })().catch((e) => {
    console.error("message handler failed", e);
    sendResponse({ ok: false, error: String(e) });
  });

  return true; // async
});

chrome.downloads.onCreated.addListener((item: any) => {
  withLock(async () => {
    const settings = await loadSettings();

    const state = await loadState();
    prunePending(state);

    let sessionUrl: string | null = null;
    let sessionTitle: string | null = null;

    // Prefer referrer (most reliable), fallback to active tab.
    if (isHttpUrl(item.referrer)) {
      sessionUrl = canonicalizeUrl(item.referrer);
    } else {
      const tab = await pickActiveTab();
      if (tab && isHttpUrl(tab.url)) {
        sessionUrl = canonicalizeUrl(tab.url || "");
        sessionTitle = tab.title;
      }
    }

    const urn = extractUrnFromFilename(item.filename);
    const id = String(item.id);

    // urn-only ON: delay recording until we can extract an URN (filename may be empty or temporary).
    if (settings.urnOnly && !urn.urn) {
      const pending: PendingRec = {
        id,
        createdAt: nowIso(),
        sessionUrl,
        sessionTitle,
        capturedAt: nowIso(),
        startTime: item.startTime || null,
        endTime: null,
        state: item.state || "in_progress",
        filename: item.filename || null,
        url: item.url || null,
        finalUrl: item.finalUrl || null,
        referrer: item.referrer || null,
        mime: item.mime || null,
        totalBytes: typeof item.totalBytes === "number" ? item.totalBytes : null
      };
      state.pending[id] = pending;
      await saveState(state);
      return;
    }

    // Accept immediately (urnOnly OFF, or URN already extracted).
    let sessionId: string | null = null;
    let resolvedSessionUrl: string | null = sessionUrl;
    if (resolvedSessionUrl) {
      const sess = await ensureSession(resolvedSessionUrl, sessionTitle, state);
      sessionId = sess.id;
    } else {
      const sess = await ensureSession("urn:unknown:session", "(unknown session)", state);
      sessionId = sess.id;
      resolvedSessionUrl = sess.url;
    }

    const commit: CommitRec = {
      id,
      sessionId,
      sessionUrl: resolvedSessionUrl,
      capturedAt: nowIso(),
      startTime: item.startTime || null,
      endTime: null,
      state: item.state || "in_progress",
      filename: item.filename || null,
      url: item.url || null,
      finalUrl: item.finalUrl || null,
      referrer: item.referrer || null,
      mime: item.mime || null,
      totalBytes: typeof item.totalBytes === "number" ? item.totalBytes : null,
      urn: urn.urn,
      urnSource: urn.source
    };

    await addCommit(commit, state);
    if (sessionId) await updateSessionStats(sessionId, state);
    await saveState(state);
    await maybeSyncSessionsIndex(state.sessions);
  });
});

chrome.downloads.onChanged.addListener((delta: any) => {
  withLock(async () => {
    if (!delta || typeof delta.id !== "number") return;
    const id = String(delta.id);

    const settings = await loadSettings();
    const state = await loadState();
    prunePending(state);

    const idx = state.commits.findIndex((c) => c.id === id);
    if (idx >= 0) {
      // Normal commit update
      const cur = state.commits[idx];
      const next: CommitRec = { ...cur };

      if (delta.state && delta.state.current) next.state = String(delta.state.current);
      if (delta.filename && delta.filename.current) {
        next.filename = String(delta.filename.current);
        const urn = extractUrnFromFilename(next.filename);
        if (urn.urn) {
          next.urn = urn.urn;
          next.urnSource = urn.source;
        }
      }
      if (delta.totalBytes && typeof delta.totalBytes.current === "number") next.totalBytes = delta.totalBytes.current;
      if (delta.endTime && delta.endTime.current) next.endTime = String(delta.endTime.current);

      state.commits[idx] = next;
      await saveState(state);
      return;
    }

    // Pending (urn-only) download: try to promote once URN becomes detectable.
    const pending = state.pending[id];
    if (!pending) return;

    if (delta.state && delta.state.current) pending.state = String(delta.state.current);
    if (delta.filename && delta.filename.current) pending.filename = String(delta.filename.current);
    if (delta.totalBytes && typeof delta.totalBytes.current === "number") pending.totalBytes = delta.totalBytes.current;
    if (delta.endTime && delta.endTime.current) pending.endTime = String(delta.endTime.current);

    const urn = extractUrnFromFilename(pending.filename);
    const shouldAccept = !!urn.urn || !settings.urnOnly;

    if (shouldAccept) {
      let sessionId: string | null = null;
      let resolvedSessionUrl: string | null = pending.sessionUrl;

      if (resolvedSessionUrl) {
        const sess = await ensureSession(resolvedSessionUrl, pending.sessionTitle, state);
        sessionId = sess.id;
      } else {
        const sess = await ensureSession("urn:unknown:session", "(unknown session)", state);
        sessionId = sess.id;
        resolvedSessionUrl = sess.url;
      }

      const commit: CommitRec = {
        id,
        sessionId,
        sessionUrl: resolvedSessionUrl,
        capturedAt: pending.capturedAt,
        startTime: pending.startTime,
        endTime: pending.endTime,
        state: pending.state,
        filename: pending.filename,
        url: pending.url,
        finalUrl: pending.finalUrl,
        referrer: pending.referrer,
        mime: pending.mime,
        totalBytes: pending.totalBytes,
        urn: urn.urn,
        urnSource: urn.source
      };

      delete state.pending[id];
      await addCommit(commit, state);
      if (sessionId) await updateSessionStats(sessionId, state);
      await saveState(state);
      await maybeSyncSessionsIndex(state.sessions);
      return;
    }

    // urn-only ON: keep pending until complete; then drop.
    if (pending.state === "complete" || pending.state === "interrupted") {
      delete state.pending[id];
      await saveState(state);
    } else {
      // keep
      state.pending[id] = pending;
      await saveState(state);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
  withLock(async () => {
    const url = tab?.url;
    const title = tab?.title;
    if (!isHttpUrl(url)) return;

    const state = await loadState();
    const canon = canonicalizeUrl(url);

    // Find session by url hash (same as ensureSession does)
    const id = (await sha256Hex(canon)).slice(0, 12);
    const s = state.sessions[id];
    if (!s) return;

    state.sessions[id] = { ...s, title: title || s.title, lastSeenAt: nowIso() };
    await saveState(state);
    await maybeSyncSessionsIndex(state.sessions);
  });
});
