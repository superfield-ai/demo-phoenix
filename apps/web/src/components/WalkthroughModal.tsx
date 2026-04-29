/**
 * @file WalkthroughModal
 *
 * Role-specific first-login onboarding walkthrough modal (issue #21).
 *
 * Renders a three-step modal walkthrough anchored to the user's role:
 *   - sales_rep: lead queue → tier badge + score rationale → stage selector
 *   - cfo: executive summary bar → scenario modeler → export button
 *   - collections_agent: case queue → contact log → payment plan panel
 *   - account_manager: customer health dashboard → health alert → intervention form
 *   - finance_controller: AR aging → invoice drilldown → write-off approvals
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
// Step type and role-specific step definitions
// Re-exported from the pure-data module so callers only need one import.
// ---------------------------------------------------------------------------

export type { WalkthroughStep } from './walkthrough-steps';
export {
  SALES_REP_STEPS,
  CFO_STEPS,
  COLLECTIONS_AGENT_STEPS,
  ACCOUNT_MANAGER_STEPS,
  FINANCE_CONTROLLER_STEPS,
  BDM_STEPS,
} from './walkthrough-steps';

import type { WalkthroughStep } from './walkthrough-steps';

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
