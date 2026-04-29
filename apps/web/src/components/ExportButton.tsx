/**
 * @file ExportButton
 *
 * One-click export button for CFO dashboard charts and tables (issue #18).
 *
 * Supports two export modes:
 *   - 'csv'  : downloads a Blob as a .csv file (for tables)
 *   - 'chart': triggers window.print() so the browser renders the current
 *              view as a PDF via the system print dialog (for charts)
 *
 * Every export embeds the current macro scenario slider state in the output
 * so recipients know what assumptions the numbers reflect.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/18
 */

import React from 'react';
import { Download } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Macro scenario slider state included in every export as a metadata block.
 */
export interface MacroScenarioState {
  interest_rate_delta: number;
  gdp_assumption: string;
  stressed_industries: string[];
}

export interface ExportButtonProps {
  /**
   * 'csv'   → downloads a CSV file. Requires `csvRows` to be provided.
   * 'chart' → triggers window.print() for PDF capture of the current chart.
   */
  mode: 'csv' | 'chart';

  /**
   * Table data rows for CSV export (column headers first, then data rows).
   * Required when mode='csv'. Each inner array is one row; each string is
   * one cell value. The export button will prepend a scenario_state metadata
   * block before the data rows.
   */
  csvRows?: string[][];

  /**
   * Current macro scenario slider state to embed in the export.
   * When omitted, the metadata block uses zero / default values.
   */
  scenarioState?: MacroScenarioState;

  /**
   * Filename for the downloaded file (without extension).
   * Defaults to `'cfo-export-<ISO date>'`.
   */
  filename?: string;

  /** Additional CSS classes for the button element. */
  className?: string;

  /** Optional accessible label for screen readers. */
  ariaLabel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV serialisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialises a 2D array of cell strings into a CSV blob.
 * Cells are double-quoted with internal double-quotes escaped.
 * A scenario_state metadata block is prepended before the data rows.
 */
export function buildCsvBlob(rows: string[][], scenarioState: MacroScenarioState): Blob {
  const allRows: string[][] = [
    ['# scenario_state'],
    ['interest_rate_delta', String(scenarioState.interest_rate_delta)],
    ['gdp_assumption', scenarioState.gdp_assumption],
    ['stressed_industries', scenarioState.stressed_industries.join('|')],
    [],
    ...rows,
  ];

  const csv = allRows
    .map((row) =>
      row.length === 0 ? '' : row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
    )
    .join('\n');

  return new Blob([csv], { type: 'text/csv;charset=utf-8' });
}

/**
 * Triggers a browser file download for the given Blob.
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SCENARIO_STATE: MacroScenarioState = {
  interest_rate_delta: 0,
  gdp_assumption: 'moderate',
  stressed_industries: [],
};

export function ExportButton({
  mode,
  csvRows,
  scenarioState = DEFAULT_SCENARIO_STATE,
  filename,
  className = '',
  ariaLabel,
}: ExportButtonProps): React.ReactElement {
  const handleClick = () => {
    if (mode === 'csv') {
      const rows = csvRows ?? [];
      const blob = buildCsvBlob(rows, scenarioState);
      const resolvedFilename = filename ?? `cfo-export-${new Date().toISOString().slice(0, 10)}`;
      triggerDownload(blob, `${resolvedFilename}.csv`);
    } else {
      // chart mode: print the current page as PDF
      window.print();
    }
  };

  const defaultLabel = mode === 'csv' ? 'Export CSV' : 'Export PDF';
  const label = ariaLabel ?? defaultLabel;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={[
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm',
        'text-indigo-600 border border-indigo-200 hover:bg-indigo-50',
        'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Download size={14} aria-hidden="true" />
      {defaultLabel}
    </button>
  );
}
