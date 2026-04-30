/**
 * fetchWithAuth — a thin wrapper around the native fetch API.
 *
 * - Always sends credentials (cookies) with every request.
 * - Calls the provided onUnauthorized callback when the server responds with
 *   HTTP 401, allowing the AuthContext to clear user state and redirect to Login.
 *
 * Usage:
 *   const fetcher = makeFetchWithAuth(logout);
 *   const res = await fetcher('/api/some-endpoint');
 */

export type OnUnauthorized = () => void | Promise<void>;

/**
 * Returns a fetch wrapper bound to the given unauthorized handler.
 *
 * The returned function has the same signature as the native `fetch` except it
 * always merges in `{ credentials: 'include' }` and invokes `onUnauthorized`
 * whenever the response status is 401.
 */
export function makeFetchWithAuth(onUnauthorized: OnUnauthorized) {
  return async function fetchWithAuth(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const merged: RequestInit = { ...init, credentials: 'include' };
    const res = await fetch(input, merged);
    if (res.status === 401) {
      await onUnauthorized();
    }
    return res;
  };
}
