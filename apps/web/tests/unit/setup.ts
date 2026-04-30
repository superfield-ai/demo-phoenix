/**
 * Global test setup for web unit tests.
 *
 * Provides a minimal sessionStorage polyfill for tests that run in the Node.js
 * environment (vitest default) but exercise code that uses the Web Storage API.
 * This is a real Map-backed implementation — not a mock.
 */

if (typeof globalThis.sessionStorage === 'undefined') {
  const store = new Map<string, string>();

  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
      getItem(key: string): string | null {
        return store.has(key) ? (store.get(key) as string) : null;
      },
      setItem(key: string, value: string): void {
        store.set(key, value);
      },
      removeItem(key: string): void {
        store.delete(key);
      },
      clear(): void {
        store.clear();
      },
      get length(): number {
        return store.size;
      },
      key(index: number): string | null {
        const keys = Array.from(store.keys());
        return index < keys.length ? keys[index] : null;
      },
    },
    writable: false,
    configurable: true,
  });
}
