function p<T>(fn: (cb: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve) => fn(resolve));
}

export async function getLocal<T>(keys: string[] | string): Promise<T> {
  return await p<T>((cb) => chrome.storage.local.get(keys, cb));
}

export async function setLocal(items: Record<string, unknown>): Promise<void> {
  await p<void>((cb) => chrome.storage.local.set(items, () => cb()));
}

export async function getSync<T>(keys: string[] | string): Promise<T> {
  return await p<T>((cb) => chrome.storage.sync.get(keys, cb));
}

export async function setSync(items: Record<string, unknown>): Promise<void> {
  await p<void>((cb) => chrome.storage.sync.set(items, () => cb()));
}
