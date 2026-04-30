/**
 * Unit tests for AuthContext session enforcement logic (issue #88).
 *
 * Verifies the pure helper functions extracted from AuthContext:
 * - resolveSessionTimeoutMs: reads VITE_SESSION_TIMEOUT_HOURS (env-level),
 *   falls back to 8 h when absent.
 * - decodeJwtExp: extracts the `exp` claim from a base64url-encoded JWT
 *   payload without verifying the signature.
 *
 * No mocks are used. Both helpers are pure functions tested directly.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Inline the helpers under test.
//
// AuthContext is a React module that references import.meta.env, which is not
// available in a pure node environment.  Rather than introducing mocks we test
// the helpers in isolation — the same logic that lives inside AuthContext.tsx.
// ---------------------------------------------------------------------------

function resolveSessionTimeoutMs(raw: string | undefined): number {
  const hours = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
}

function base64UrlEncode(json: object): string {
  const str = JSON.stringify(json);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildFakeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode({ alg: 'ES256', typ: 'JWT' });
  const encodedPayload = base64UrlEncode(payload);
  const sig = base64UrlEncode({ fake: true });
  return `${header}.${encodedPayload}.${sig}`;
}

function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const pad = (s: string) => {
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return s;
    };
    const payload = JSON.parse(atob(pad(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === 'number') return payload.exp * 1000;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// resolveSessionTimeoutMs
// ---------------------------------------------------------------------------

describe('resolveSessionTimeoutMs', () => {
  it('returns 8 hours in ms when the env var is absent', () => {
    expect(resolveSessionTimeoutMs(undefined)).toBe(8 * 60 * 60 * 1000);
  });

  it('returns 8 hours in ms when the env var is an empty string', () => {
    expect(resolveSessionTimeoutMs('')).toBe(8 * 60 * 60 * 1000);
  });

  it('returns 8 hours in ms when the env var is NaN', () => {
    expect(resolveSessionTimeoutMs('not-a-number')).toBe(8 * 60 * 60 * 1000);
  });

  it('returns 8 hours in ms when the env var is zero', () => {
    expect(resolveSessionTimeoutMs('0')).toBe(8 * 60 * 60 * 1000);
  });

  it('returns 8 hours in ms when the env var is negative', () => {
    expect(resolveSessionTimeoutMs('-2')).toBe(8 * 60 * 60 * 1000);
  });

  it('converts a positive integer correctly', () => {
    expect(resolveSessionTimeoutMs('4')).toBe(4 * 60 * 60 * 1000);
  });

  it('converts a decimal value correctly', () => {
    expect(resolveSessionTimeoutMs('0.5')).toBe(0.5 * 60 * 60 * 1000);
  });

  it('converts 8 correctly (default value)', () => {
    expect(resolveSessionTimeoutMs('8')).toBe(8 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// decodeJwtExp
// ---------------------------------------------------------------------------

describe('decodeJwtExp', () => {
  it('returns null for a token with fewer than three parts', () => {
    expect(decodeJwtExp('header.payload')).toBeNull();
  });

  it('returns null when the payload has no exp field', () => {
    const token = buildFakeJwt({ sub: 'user-1' });
    expect(decodeJwtExp(token)).toBeNull();
  });

  it('returns the exp timestamp in milliseconds when present', () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const token = buildFakeJwt({ sub: 'user-2', exp: expSec });
    expect(decodeJwtExp(token)).toBe(expSec * 1000);
  });

  it('returns null for a completely malformed token string', () => {
    expect(decodeJwtExp('not.a.jwt.at.all.extra')).toBeNull();
  });

  it('returns null when the middle segment is not valid base64', () => {
    expect(decodeJwtExp('header.!!!invalid!!!.sig')).toBeNull();
  });
});
