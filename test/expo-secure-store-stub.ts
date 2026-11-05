const store = new Map<string, string>();

export async function getItemAsync(key: string) {
  return store.has(key) ? store.get(key)! : null;
}

export async function setItemAsync(key: string, value: string) {
  store.set(key, value);
}

export async function deleteItemAsync(key: string) {
  store.delete(key);
}

export function __resetSecureStoreMock() {
  store.clear();
}

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';
