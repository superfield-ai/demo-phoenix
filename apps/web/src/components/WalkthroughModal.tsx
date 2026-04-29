/**
 * @file WalkthroughModal
 *
 * Role-specific first-login onboarding walkthrough modal (issue #21).
 *
 * Renders a three-step modal walkthrough anchored to the user's role:
 *   - sales_rep: lead queue → tier badge + score rationale → stage selector
 *   - cfo: executive summary bar → scenario modeler → export button
 *
 * Dismissible at any step. On dismiss or completion, calls
 * PATCH /api/users/me/onboarding to set onboarding_completed=true so the
 * walkthrough is not shown again on subsequent logins.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/21
 */

import React from 'react';
import { X, ChevronRight } from 'lucide-react';

// ---------------------------------------------------------------------------
// Step type
// ---------------------------------------------------------------------------

export interface WalkthroughStep {
  title: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Role-specific step definitions
// ---------------------------------------------------------------------------

export const SALES_REP_STEPS: WalkthroughStep[] = [
  {
    title: 'Lead Queue',
    description:
      'Your lead queue lists all active prospects ranked by their composite score. Higher-scored leads convert at a greater rate — always prioritise from the top.',
  },
  {
    title: 'Tier Badge & Score Rationale',
    description:
      'Each lead carries a tier badge (A / B / C) derived from its CLTV estimate. Click the badge or score to open the score rationale panel, which explains the main factors driving the rank.',
  },
  {
    title: 'Stage Selector & Required Notes',
    description:
      'Use the stage selector pin in the lead detail view to progress a deal through the pipeline. Each stage transition requires a note so your team keeps full context.',
  },
];

export const CFO_STEPS: WalkthroughStep[] = [
  {
    title: 'Executive Summary Bar',
    description:
      'The summary bar at the top of the CFO dashboard shows five live portfolio metrics: pipeline by tier, weighted close rate, AR aging, collection recovery rate, and active score model version.',
  },
  {
    title: 'Scenario Modeler',
    description:
      'Use the scenario modeler sliders to stress-test your portfolio under different macro conditions — interest rate changes and GDP growth scenarios — and see CLTV estimates recomputed instantly.',
  },
  {
    title: 'Export Button',
    description:
      'Click Export to download a CSV of the current portfolio view, including any active scenario overrides. Useful for offline analysis or board presentations.',
  },
];

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

export async function markOnboardingComplete(): Promise<void> {
  await fetch('/api/users/me/onboarding', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onboarding_completed: true }),
  });
}

export async function resetOnboarding(): Promise<void> {
  await fetch('/api/users/me/onboarding', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onboarding_completed: false }),
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface WalkthroughModalProps {
  steps: WalkthroughStep[];
  onClose: () => void;
}

export function WalkthroughModal({ steps, onClose }: WalkthroughModalProps) {
  const [currentStep, setCurrentStep] = React.useState(0);
  const total = steps.length;
  const step = steps[currentStep];

  async function handleDismiss() {
    await markOnboardingComplete();
    onClose();
  }

  async function handleNext() {
    if (currentStep < total - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      await markOnboardingComplete();
      onClose();
    }
  }

  return (
    /* Backdrop */
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Onboarding walkthrough"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      {/* Card */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-8 flex flex-col gap-6">
        {/* Close button */}
        <button
          onClick={handleDismiss}
          aria-label="Dismiss walkthrough"
          className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-600 transition-colors"
        >
          <X size={20} />
        </button>

        {/* Step indicator */}
        <div className="flex items-center gap-2">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-2 rounded-full transition-all ${
                i === currentStep
                  ? 'w-6 bg-indigo-500'
                  : i < currentStep
                    ? 'w-2 bg-indigo-300'
                    : 'w-2 bg-zinc-200'
              }`}
            />
          ))}
          <span className="ml-auto text-xs text-zinc-400 font-medium">
            {currentStep + 1} / {total}
          </span>
        </div>

        {/* Content */}
        <div className="flex flex-col gap-3">
          <h2 className="text-xl font-bold text-zinc-900">{step.title}</h2>
          <p className="text-sm text-zinc-600 leading-relaxed">{step.description}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={handleDismiss}
            className="text-sm text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            Skip tour
          </button>
          <button
            onClick={handleNext}
            className="flex items-center gap-1 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition-colors"
          >
            {currentStep < total - 1 ? (
              <>
                Next
                <ChevronRight size={16} />
              </>
            ) : (
              'Get started'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
