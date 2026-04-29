/**
 * @file CollectionsPerformancePanel
 *
 * Collections performance panel for the CFO dashboard (issue #17).
 *
 * Displays four metric sections:
 *   1. Agent recovery rates — bar chart with anonymized agent IDs (cfo) or real names (finance_controller)
 *   2. Average days to resolution by escalation level
 *   3. Trailing 12-month write-off rate and total write-off amount
 *   4. Payment plan success rate
 *
 * Gated to cfo and finance_controller roles. Returns null for all other roles.
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/17
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { SkeletonChart } from './Skeleton';
import { ContextualEmptyState } from './ContextualEmptyState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentRecoveryRate {
  agent_id: string;
  total_cases: number;
  recovered_cases: number;
  recovery_rate: number;
}

interface EscalationResolutionEntry {
  escalation_level: number;
  avg_days_to_resolution: number;
}

interface CollectionsPerformanceData {
  agent_recovery_rates: AgentRecoveryRate[];
  avg_days_to_resolution_by_escalation_level: EscalationResolutionEntry[];
  write_off_rate_12m: number;
  write_off_amount_12m: number;
  payment_plan_success_rate: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

const CFO_ROLES = new Set(['cfo', 'finance_controller']);

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface AgentBarChartProps {
  rates: AgentRecoveryRate[];
}

function AgentBarChart({ rates }: AgentBarChartProps) {
  if (rates.length === 0) {
    return (
      <ContextualEmptyState
        message="No agent recovery data yet — collection cases must be closed before recovery rates can be computed"
        testId="agent-recovery-empty-state"
      />
    );
  }

  const maxRate = Math.max(...rates.map((r) => r.recovery_rate), 0.01);

  return (
    <div className="space-y-3" role="list" aria-label="Agent recovery rates">
      {rates.map((agent) => (
        <div key={agent.agent_id} role="listitem" className="flex items-center gap-3">
          <span className="w-24 text-xs text-gray-600 truncate text-right flex-shrink-0">
            {agent.agent_id}
          </span>
          <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
            <div
              className="h-4 rounded-full bg-blue-500 transition-all"
              style={{ width: `${(agent.recovery_rate / maxRate) * 100}%` }}
              aria-label={`${agent.agent_id}: ${pct(agent.recovery_rate)}`}
            />
          </div>
          <span className="w-16 text-xs text-gray-700 font-medium flex-shrink-0">
            {pct(agent.recovery_rate)}
          </span>
          <span className="text-xs text-gray-400 flex-shrink-0">
            ({agent.recovered_cases}/{agent.total_cases})
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CollectionsPerformancePanel
// ---------------------------------------------------------------------------

export function CollectionsPerformancePanel() {
  const { user } = useAuth();
  const [data, setData] = useState<CollectionsPerformanceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isCfoUser = user?.role !== undefined && user.role !== null && CFO_ROLES.has(user.role);

  useEffect(() => {
    if (!isCfoUser) {
      setLoading(false);
      return;
    }

    fetch('/api/cfo/collections-performance', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<CollectionsPerformanceData>;
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err.message ?? 'Failed to load collections performance data');
      })
      .finally(() => setLoading(false));
  }, [isCfoUser]);

  if (!isCfoUser) return null;

  if (loading) {
    return <SkeletonChart />;
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-red-600">
        Collections performance unavailable: {error}
      </div>
    );
  }

  if (!data) return null;

  const {
    agent_recovery_rates,
    avg_days_to_resolution_by_escalation_level,
    write_off_rate_12m,
    write_off_amount_12m,
    payment_plan_success_rate,
  } = data;

  return (
    <div
      className="space-y-8"
      data-testid="collections-performance-panel"
      aria-label="Collections performance panel"
    >
      {/* Section 1: Agent Recovery Rates */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-4">Recovery Rate by Agent</h3>
        <AgentBarChart rates={agent_recovery_rates} />
      </div>

      {/* Section 2: Average Days to Resolution by Escalation Level */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-4">
          Avg Days to Resolution by Escalation Level
        </h3>
        {avg_days_to_resolution_by_escalation_level.length === 0 ? (
          <ContextualEmptyState
            message="No resolution data yet — days-to-resolution is computed once collection cases are closed"
            testId="resolution-empty-state"
          />
        ) : (
          <div className="divide-y divide-gray-100" role="list">
            {avg_days_to_resolution_by_escalation_level.map((entry) => (
              <div
                key={entry.escalation_level}
                role="listitem"
                className="flex justify-between items-center py-3"
              >
                <span className="text-sm text-gray-600">
                  Escalation Level {entry.escalation_level}
                </span>
                <span className="text-sm font-semibold text-gray-900">
                  {entry.avg_days_to_resolution.toFixed(1)} days
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 3: Write-off Stats (trailing 12 months) */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-4">
          Write-offs — Trailing 12 Months
        </h3>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Write-off Rate
            </p>
            <p className="text-2xl font-bold text-gray-900">{pct(write_off_rate_12m)}</p>
            <p className="text-xs text-gray-400 mt-1">of closed cases written off</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Total Write-off Amount
            </p>
            <p className="text-2xl font-bold text-gray-900">{fmt(write_off_amount_12m)}</p>
            <p className="text-xs text-gray-400 mt-1">sum of written-off invoice amounts</p>
          </div>
        </div>
      </div>

      {/* Section 4: Payment Plan Success Rate */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-4">Payment Plan Success Rate</h3>
        <div className="flex items-end gap-4">
          <p className="text-3xl font-bold text-gray-900">{pct(payment_plan_success_rate)}</p>
          <p className="text-sm text-gray-500 pb-1">
            of closed payment plans completed successfully
          </p>
        </div>
        {/* Visual bar */}
        <div className="mt-4 bg-gray-100 rounded-full h-3 overflow-hidden">
          <div
            className="h-3 rounded-full bg-green-500 transition-all"
            style={{ width: `${payment_plan_success_rate * 100}%` }}
            aria-label={`Payment plan success rate: ${pct(payment_plan_success_rate)}`}
          />
        </div>
      </div>
    </div>
  );
}
