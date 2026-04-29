#!/usr/bin/env bun
/**
 * @file seed/run-demo-seed
 * Standalone runner for demo seed data.
 *
 * Usage:
 *   DEMO_MODE=true DATABASE_URL=<url> bun run apps/server/src/seed/run-demo-seed.ts
 *
 * Or via the package.json alias:
 *   DATABASE_URL=<url> bun run seed:demo
 *
 * The script migrates the database, seeds demo users, then seeds all
 * revenue-lifecycle demo data. Idempotent: safe to run multiple times.
 */

import { sql, migrate } from 'db';
import { seedDemoUsers } from './demo-users';
import { seedDemoData } from './demo-data';

if (process.env.DEMO_MODE !== 'true') {
  console.error('[seed:demo] DEMO_MODE must be set to "true". Exiting.');
  process.exit(1);
}

console.log('[seed:demo] Running migrations...');
await migrate();

console.log('[seed:demo] Seeding demo users...');
await seedDemoUsers({ sql });

console.log('[seed:demo] Seeding demo revenue-lifecycle data...');
await seedDemoData({ sql });

await sql.end();
console.log('[seed:demo] Done.');
process.exit(0);
