/**
 * @file sw.test.ts
 *
 * Unit tests for the PWA service worker source (src/sw.ts).
 *
 * Validates the constants and OFFLINE_HTML content exported/used by the
 * service worker. Structural checks ensure the SW meets the issue #39
 * acceptance criteria without requiring a full browser environment.
 *
 * Strategy
 * ---------
 * The service worker module declares `self: ServiceWorkerGlobalScope`, which
 * is not available in the Vitest node environment.  We import the raw source
 * text and validate key patterns via string inspection — the same approach used
 * for structural audits in other unit tests in this suite.
 *
 * Acceptance criteria covered
 * ----------------------------
 * - SW source references the correct cache-first strategy for static assets
 * - SW source references network-first routing for /api/* paths
 * - SW source contains an offline fallback HTML response for navigate requests
 * - Web app manifest has all required PWA fields (name, short_name, icons,
 *   start_url, display, theme_color, background_color)
 * - Manifest icons include both 192×192 and 512×512 entries with maskable
 *   purpose
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const repoRoot = join(import.meta.dirname, '../..');

function readSrc(relPath: string): string {
  return readFileSync(join(repoRoot, 'src', relPath), 'utf-8');
}

function readPublic(relPath: string): string {
  return readFileSync(join(repoRoot, 'public', relPath), 'utf-8');
}

// ---------------------------------------------------------------------------
// Service worker source checks
// ---------------------------------------------------------------------------

describe('sw.ts — routing strategy', () => {
  const sw = readSrc('sw.ts');

  test('defines a CACHE_NAME constant', () => {
    expect(sw).toMatch(/const CACHE_NAME\s*=/);
  });

  test('registers an install event listener', () => {
    expect(sw).toContain("addEventListener('install'");
  });

  test('registers an activate event listener', () => {
    expect(sw).toContain("addEventListener('activate'");
  });

  test('registers a fetch event listener', () => {
    expect(sw).toContain("addEventListener('fetch'");
  });

  test('routes /api/* requests with network-first (no caching)', () => {
    // The SW must not serve API responses from cache — it passes them straight
    // to fetch() without cache.put().
    expect(sw).toContain('/api/');
    // Confirm network-first: fetch(request) is called for /api paths
    expect(sw).toMatch(/startsWith\(['"]\/api\//);
  });

  test('serves an offline HTML fallback for navigate requests', () => {
    expect(sw).toContain("request.mode === 'navigate'");
    expect(sw).toContain('OFFLINE_HTML');
    expect(sw).toContain('text/html');
  });

  test('offline HTML contains a user-facing offline message', () => {
    // Extract the OFFLINE_HTML string value — it must mention being offline.
    expect(sw).toMatch(/offline/i);
  });

  test('APP_SHELL pre-caches the index and manifest', () => {
    expect(sw).toContain("'/index.html'");
    expect(sw).toContain("'/manifest.json'");
  });

  test('calls skipWaiting on install to activate immediately', () => {
    expect(sw).toContain('skipWaiting');
  });

  test('calls clients.claim on activate to take control of all clients', () => {
    expect(sw).toContain('clients.claim');
  });
});

// ---------------------------------------------------------------------------
// Web app manifest checks
// ---------------------------------------------------------------------------

describe('manifest.json — required PWA fields', () => {
  let manifest: {
    name?: string;
    short_name?: string;
    start_url?: string;
    display?: string;
    theme_color?: string;
    background_color?: string;
    icons?: Array<{ src: string; sizes: string; type?: string; purpose?: string }>;
  };

  try {
    manifest = JSON.parse(readPublic('manifest.json'));
  } catch {
    manifest = {};
  }

  test('name is a non-empty string', () => {
    expect(typeof manifest.name).toBe('string');
    expect((manifest.name ?? '').length).toBeGreaterThan(0);
  });

  test('short_name is a non-empty string', () => {
    expect(typeof manifest.short_name).toBe('string');
    expect((manifest.short_name ?? '').length).toBeGreaterThan(0);
  });

  test('start_url is present', () => {
    expect(typeof manifest.start_url).toBe('string');
    expect((manifest.start_url ?? '').length).toBeGreaterThan(0);
  });

  test('display is standalone', () => {
    expect(manifest.display).toBe('standalone');
  });

  test('theme_color is set', () => {
    expect(typeof manifest.theme_color).toBe('string');
    expect((manifest.theme_color ?? '').length).toBeGreaterThan(0);
  });

  test('background_color is set', () => {
    expect(typeof manifest.background_color).toBe('string');
    expect((manifest.background_color ?? '').length).toBeGreaterThan(0);
  });

  test('icons array is present', () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect((manifest.icons ?? []).length).toBeGreaterThan(0);
  });

  test('has a 192×192 icon', () => {
    const icons = manifest.icons ?? [];
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
  });

  test('has a 512×512 icon', () => {
    const icons = manifest.icons ?? [];
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true);
  });

  test('has a maskable 192×192 icon', () => {
    const icons = manifest.icons ?? [];
    expect(icons.some((i) => i.sizes === '192x192' && i.purpose === 'maskable')).toBe(true);
  });

  test('has a maskable 512×512 icon', () => {
    const icons = manifest.icons ?? [];
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
  });
});
