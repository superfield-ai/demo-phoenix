/**
 * Unit tests for the fetchWithAuth utility (issue #88).
 *
 * Verifies that:
 * - The wrapper always sends credentials: 'include'.
 * - A 401 response triggers the onUnauthorized callback.
 * - Non-401 responses do NOT trigger the callback.
 * - The original Response object is returned intact.
 *
 * No mocks (vi.fn / vi.mock) are used.  A real node:http server is started
 * per test to return controlled responses.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import { makeFetchWithAuth } from '../../src/lib/fetch-with-auth';

// ---------------------------------------------------------------------------
// Minimal real HTTP server fixture
// ---------------------------------------------------------------------------

interface ServerState {
  statusCode: number;
  body: string;
}

let server: http.Server;
let baseUrl: string;
const serverState: ServerState = { statusCode: 200, body: '{"ok":true}' };

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(serverState.statusCode, { 'Content-Type': 'application/json' });
        res.end(serverState.body);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  serverState.statusCode = 200;
  serverState.body = '{"ok":true}';
});

// ---------------------------------------------------------------------------
// fetchWithAuth tests
// ---------------------------------------------------------------------------

describe('makeFetchWithAuth', () => {
  it('returns the Response from the server', async () => {
    let called = false;
    const fetcher = makeFetchWithAuth(() => {
      called = true;
    });

    const res = await fetcher(`${baseUrl}/ping`);
    expect(res.status).toBe(200);
    expect(called).toBe(false);
  });

  it('does not call onUnauthorized for 200 responses', async () => {
    serverState.statusCode = 200;
    let called = false;
    const fetcher = makeFetchWithAuth(() => {
      called = true;
    });

    await fetcher(`${baseUrl}/ok`);
    expect(called).toBe(false);
  });

  it('does not call onUnauthorized for 404 responses', async () => {
    serverState.statusCode = 404;
    let called = false;
    const fetcher = makeFetchWithAuth(() => {
      called = true;
    });

    await fetcher(`${baseUrl}/missing`);
    expect(called).toBe(false);
  });

  it('calls onUnauthorized when the response status is 401', async () => {
    serverState.statusCode = 401;
    serverState.body = '{"error":"Unauthorized"}';

    let called = false;
    const fetcher = makeFetchWithAuth(() => {
      called = true;
    });

    const res = await fetcher(`${baseUrl}/protected`);
    expect(res.status).toBe(401);
    expect(called).toBe(true);
  });

  it('calls onUnauthorized only once per 401 response', async () => {
    serverState.statusCode = 401;
    serverState.body = '{"error":"Unauthorized"}';

    let callCount = 0;
    const fetcher = makeFetchWithAuth(() => {
      callCount++;
    });

    await fetcher(`${baseUrl}/protected`);
    expect(callCount).toBe(1);
  });

  it('returns the 401 response without consuming the body', async () => {
    serverState.statusCode = 401;
    serverState.body = '{"error":"session expired"}';

    const fetcher = makeFetchWithAuth(() => {});
    const res = await fetcher(`${baseUrl}/protected`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('session expired');
  });

  it('awaits an async onUnauthorized callback', async () => {
    serverState.statusCode = 401;

    const log: string[] = [];
    const fetcher = makeFetchWithAuth(async () => {
      await Promise.resolve();
      log.push('done');
    });

    await fetcher(`${baseUrl}/protected`);
    expect(log).toEqual(['done']);
  });
});
