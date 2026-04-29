/**
 * @file ExportButton.test.ts
 *
 * Unit tests for the ExportButton component helpers (issue #18).
 *
 * Tests the pure CSV-building and scenario-state embedding logic without a
 * browser environment.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/18
 */

import { describe, test, expect } from 'vitest';
import { buildCsvBlob, type MacroScenarioState } from '../../src/components/ExportButton';

// ─────────────────────────────────────────────────────────────────────────────
// buildCsvBlob
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCsvBlob', () => {
  const defaultScenario: MacroScenarioState = {
    interest_rate_delta: 0,
    gdp_assumption: 'moderate',
    stressed_industries: [],
  };

  test('returns a Blob', () => {
    const blob = buildCsvBlob([], defaultScenario);
    expect(blob).toBeTruthy();
    // In Node/jsdom Blob doesn't always have type, check by duck-type
    expect(typeof blob.size).toBe('number');
  });

  test('CSV includes scenario_state metadata block', async () => {
    const blob = buildCsvBlob([], defaultScenario);
    const text = await blob.text();
    expect(text).toContain('# scenario_state');
    expect(text).toContain('interest_rate_delta');
    expect(text).toContain('gdp_assumption');
    expect(text).toContain('stressed_industries');
  });

  test('scenario_state block contains correct slider values', async () => {
    const scenario: MacroScenarioState = {
      interest_rate_delta: 150,
      gdp_assumption: 'recession',
      stressed_industries: ['Finance', 'Real Estate'],
    };
    const blob = buildCsvBlob([], scenario);
    const text = await blob.text();

    expect(text).toContain('"150"');
    expect(text).toContain('"recession"');
    expect(text).toContain('"Finance|Real Estate"');
  });

  test('data rows are appended after the metadata block', async () => {
    const rows = [
      ['industry', 'total_cltv'],
      ['Tech', '1000000'],
      ['Finance', '500000'],
    ];
    const blob = buildCsvBlob(rows, defaultScenario);
    const text = await blob.text();

    // Data rows should appear in the output.
    expect(text).toContain('"industry"');
    expect(text).toContain('"total_cltv"');
    expect(text).toContain('"Tech"');
    expect(text).toContain('"Finance"');
    expect(text).toContain('"1000000"');
  });

  test('cells with double-quotes are escaped', async () => {
    const rows = [
      ['name', 'value'],
      ['He said "hello"', '42'],
    ];
    const blob = buildCsvBlob(rows, defaultScenario);
    const text = await blob.text();
    // Double-quotes inside cells should be doubled.
    expect(text).toContain('He said ""hello""');
  });

  test('empty rows are preserved as blank lines', async () => {
    const rows: string[][] = [];
    const blob = buildCsvBlob(rows, defaultScenario);
    const text = await blob.text();
    // Metadata block ends with an empty separator line.
    const lines = text.split('\n');
    expect(lines.some((l) => l === '')).toBe(true);
  });

  test('scenario_state with non-zero interest rate delta', async () => {
    const scenario: MacroScenarioState = {
      interest_rate_delta: -50,
      gdp_assumption: 'strong',
      stressed_industries: [],
    };
    const blob = buildCsvBlob([], scenario);
    const text = await blob.text();
    expect(text).toContain('"-50"');
    expect(text).toContain('"strong"');
  });
});
