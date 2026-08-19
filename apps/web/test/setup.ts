import "@testing-library/jest-dom/vitest";

// Node 22+ ships its own built-in global `localStorage` (an experimental
// Web Storage implementation). Vitest's jsdom bridge (populateGlobal in
// vitest/dist/chunks/index.*.js) only copies a window property onto
// globalThis when the key is either absent from globalThis or in its own
// explicit allow-list; "localStorage" is in neither state once Node has
// already defined it, so jsdom's real, working implementation never gets
// bridged over -- Node's own accessor is left in place instead, and it
// requires --localstorage-file to actually function. Without that flag,
// `globalThis.localStorage` exists but every method throws or is
// undefined, silently breaking every test that touches localStorage. This
// is purely a host-Node-version/vitest-version interaction, nothing jsdom
// or this suite should depend on -- so replace it with a minimal,
// self-contained in-memory Storage implementation, entirely independent of
// whichever Node version happens to run the suite.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  } as Storage;
}

Object.defineProperty(globalThis, "localStorage", {
  value: createMemoryStorage(),
  configurable: true,
  writable: true,
});
