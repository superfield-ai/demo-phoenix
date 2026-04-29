/**
 * @file ScoreTooltip.tsx
 *
 * Score explanation tooltip component — Phase 3 Polish and Trust (issue #20).
 *
 * Renders a ? icon that, when hovered or clicked, opens a popover with:
 *   - A one-sentence plain-English summary of the score element (summary_text).
 *   - An optional "Expand" link that reveals formula and input snapshot values
 *     (detail_content) without making a network request.
 *
 * ## Usage
 *
 *   <ScoreTooltip
 *     summary_text="Tier A leads have the highest composite CLTV score (≥ 80) and are your strongest revenue opportunities."
 *     detail_content={{
 *       formula: "composite = macro×0.30 + industry×0.30 + company×0.40",
 *       inputs: { macro_score: 0.85, industry_score: 0.72, company_score: 0.91 },
 *     }}
 *   />
 *
 * ## No API calls
 *
 * All content is passed as props derived from the already-loaded CLTVScore record.
 * The component never fetches data — expanding the detail section reads only from
 * the props passed at render time.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/20
 */

import React, { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoreDetailContent {
  /** Human-readable formula string, e.g. "composite = macro×0.30 + industry×0.30 + company×0.40". */
  formula: string;
  /**
   * Key-value map of the actual input values used to produce this score.
   * Typically sourced from macro_inputs_snapshot, industry_inputs_snapshot,
   * and company_inputs_snapshot on the CLTVScore record.
   */
  inputs: Record<string, number | string | null>;
}

export interface ScoreTooltipProps {
  /** One-sentence plain-English summary shown immediately on hover/click. */
  summary_text: string;
  /**
   * Optional detail content (formula + input values) shown after expanding.
   * When omitted the Expand link is not rendered.
   */
  detail_content?: ScoreDetailContent;
  /** Optional accessible label for the trigger button. Defaults to "Score explanation". */
  aria_label?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatInputValue(value: number | string | null): string {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'number') {
    // Render percentages for values in [0, 1]; render plain numbers otherwise.
    if (value >= 0 && value <= 1) return `${(value * 100).toFixed(1)}%`;
    return String(value);
  }
  return String(value);
}

function humaniseKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// ScoreTooltip
// ---------------------------------------------------------------------------

/**
 * ScoreTooltip
 *
 * Renders a small ? icon button. On hover or click the popover opens, showing
 * the summary. An "Expand" link within the popover reveals formula and inputs
 * read from props — no network request is made.
 */
export function ScoreTooltip({
  summary_text,
  detail_content,
  aria_label = 'Score explanation',
}: ScoreTooltipProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setExpanded(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setExpanded(false);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex items-center"
      data-testid="score-tooltip-wrapper"
    >
      {/* Trigger */}
      <button
        type="button"
        aria-label={aria_label}
        aria-expanded={open}
        data-testid="score-tooltip-trigger"
        onMouseEnter={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onClick={() => {
          // On click, always open the popover (click is a positive action).
          // If already open (from hover + click), keep it open (pin it).
          setOpen(true);
        }}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-zinc-200 hover:bg-zinc-300 text-zinc-600 text-[10px] font-bold leading-none cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 select-none ml-1"
      >
        ?
      </button>

      {/* Popover */}
      {open && (
        <div
          role="tooltip"
          data-testid="score-tooltip-popover"
          className="absolute z-50 bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 rounded-lg border border-zinc-200 bg-white shadow-lg text-xs"
        >
          {/* Summary */}
          <div
            className="px-3 py-2.5 text-zinc-700 leading-relaxed"
            data-testid="score-tooltip-summary"
          >
            {summary_text}
          </div>

          {/* Detail (expand/collapse) */}
          {detail_content && (
            <div className="border-t border-zinc-100">
              <button
                type="button"
                data-testid="score-tooltip-expand-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((x) => !x);
                }}
                className="w-full text-left px-3 py-1.5 text-indigo-600 hover:text-indigo-700 font-medium text-xs flex items-center gap-1 transition-colors"
                aria-expanded={expanded}
              >
                <span
                  className="inline-block transition-transform"
                  style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
                  aria-hidden="true"
                >
                  ▶
                </span>
                {expanded ? 'Collapse' : 'Expand'}
              </button>

              {expanded && (
                <div className="px-3 pb-3 space-y-2" data-testid="score-tooltip-detail">
                  {/* Formula */}
                  <div>
                    <p className="text-zinc-500 uppercase tracking-wide text-[10px] font-medium mb-0.5">
                      Formula
                    </p>
                    <code
                      className="block text-zinc-800 font-mono text-[10px] bg-zinc-50 rounded p-1.5 break-all"
                      data-testid="score-tooltip-formula"
                    >
                      {detail_content.formula}
                    </code>
                  </div>

                  {/* Input values */}
                  <div>
                    <p className="text-zinc-500 uppercase tracking-wide text-[10px] font-medium mb-0.5">
                      Inputs used
                    </p>
                    <dl className="space-y-0.5" data-testid="score-tooltip-inputs">
                      {Object.entries(detail_content.inputs).map(([key, value]) => (
                        <div key={key} className="flex items-baseline justify-between gap-2">
                          <dt className="text-zinc-500 truncate">{humaniseKey(key)}</dt>
                          <dd className="text-zinc-800 font-medium shrink-0">
                            {formatInputValue(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
