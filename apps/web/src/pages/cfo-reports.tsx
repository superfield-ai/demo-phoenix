/**
 * @file cfo-reports.tsx
 *
 * CFO Reports page with four ECharts-powered visualizations:
 *   1. AR Aging bar chart (0–30, 31–60, 61–90, 90+ days)
 *   2. CLTV portfolio donut chart (A/B/C/D score tiers)
 *   3. Monthly revenue trend line chart (collected vs outstanding, last 12 months)
 *   4. Collections recovery rate bar chart (by month)
 *
 * Charts render with seeded demo data on mount — no live API calls required.
 * Visible only to CFO and Superadmin.
 *
 * @see https://github.com/superfield-ai/demo-phoenix/issues/81
 */

import React from 'react';
import ReactECharts from 'echarts-for-react';

// ---------------------------------------------------------------------------
// Seeded demo data
// ---------------------------------------------------------------------------

/** AR Aging buckets (outstanding invoice amounts in £k) */
const AR_AGING_DATA = [
  { bucket: '0–30 days', amount: 284 },
  { bucket: '31–60 days', amount: 156 },
  { bucket: '61–90 days', amount: 89 },
  { bucket: '90+ days', amount: 47 },
];

/** CLTV distribution by score tier */
const CLTV_DATA = [
  { name: 'A — Prime', value: 38 },
  { name: 'B — Near-prime', value: 29 },
  { name: 'C — Sub-prime', value: 22 },
  { name: 'D — High-risk', value: 11 },
];

/** Last 12 calendar months */
const MONTHS = ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'];

/** Monthly collected revenue (£k) */
const COLLECTED = [410, 430, 395, 450, 470, 460, 490, 510, 480, 520, 545, 560];

/** Monthly outstanding revenue (£k) */
const OUTSTANDING = [120, 135, 150, 130, 125, 140, 155, 145, 160, 138, 142, 130];

/** Collections recovery rate by month (%) */
const RECOVERY_RATE = [74, 76, 72, 78, 80, 77, 82, 84, 79, 86, 88, 90];

// ---------------------------------------------------------------------------
// ECharts option builders
// ---------------------------------------------------------------------------

function arAgingOption() {
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 16, bottom: 48 },
    xAxis: {
      type: 'category',
      data: AR_AGING_DATA.map((d) => d.bucket),
      axisLabel: { fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: '£k',
      nameTextStyle: { fontSize: 11 },
      axisLabel: { fontSize: 11 },
    },
    series: [
      {
        name: 'Outstanding (£k)',
        type: 'bar',
        data: AR_AGING_DATA.map((d) => d.amount),
        itemStyle: {
          color: (params: { dataIndex: number }) => {
            const colours = ['#6366f1', '#818cf8', '#f59e0b', '#ef4444'];
            return colours[params.dataIndex] ?? '#6366f1';
          },
        },
        barMaxWidth: 56,
      },
    ],
  };
}

function cltvDonutOption() {
  const COLOURS = ['#6366f1', '#818cf8', '#f59e0b', '#ef4444'];
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
    legend: {
      orient: 'vertical',
      right: 8,
      top: 'center',
      textStyle: { fontSize: 11 },
    },
    series: [
      {
        name: 'CLTV Tier',
        type: 'pie',
        radius: ['42%', '70%'],
        center: ['38%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        data: CLTV_DATA.map((d, i) => ({
          name: d.name,
          value: d.value,
          itemStyle: { color: COLOURS[i] },
        })),
      },
    ],
  };
}

function revenueTrendOption() {
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['Collected', 'Outstanding'], top: 0, textStyle: { fontSize: 11 } },
    grid: { left: 60, right: 20, top: 32, bottom: 48 },
    xAxis: {
      type: 'category',
      data: MONTHS,
      axisLabel: { fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: '£k',
      nameTextStyle: { fontSize: 11 },
      axisLabel: { fontSize: 11 },
    },
    series: [
      {
        name: 'Collected',
        type: 'line',
        smooth: true,
        data: COLLECTED,
        itemStyle: { color: '#6366f1' },
        lineStyle: { color: '#6366f1', width: 2 },
        areaStyle: { color: 'rgba(99,102,241,0.08)' },
      },
      {
        name: 'Outstanding',
        type: 'line',
        smooth: true,
        data: OUTSTANDING,
        itemStyle: { color: '#f59e0b' },
        lineStyle: { color: '#f59e0b', width: 2 },
        areaStyle: { color: 'rgba(245,158,11,0.08)' },
      },
    ],
  };
}

function recoveryRateOption() {
  return {
    tooltip: { trigger: 'axis', formatter: '{b}: {c}%' },
    grid: { left: 56, right: 20, top: 16, bottom: 48 },
    xAxis: {
      type: 'category',
      data: MONTHS,
      axisLabel: { fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: '%',
      min: 60,
      max: 100,
      nameTextStyle: { fontSize: 11 },
      axisLabel: { fontSize: 11 },
    },
    series: [
      {
        name: 'Recovery Rate (%)',
        type: 'bar',
        data: RECOVERY_RATE,
        itemStyle: { color: '#6366f1' },
        barMaxWidth: 36,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Chart card wrapper
// ---------------------------------------------------------------------------

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  testId?: string;
}

function ChartCard({ title, subtitle, children, testId }: ChartCardProps) {
  return (
    <div
      className="bg-white rounded-xl border border-zinc-200 p-4 flex flex-col gap-2"
      data-testid={testId}
    >
      <div>
        <h3 className="text-sm font-semibold text-zinc-800">{title}</h3>
        {subtitle && <p className="text-xs text-zinc-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CfoReportsPage
// ---------------------------------------------------------------------------

/** Shared ECharts options applied to every chart */
const ECHART_STYLE = { height: 240 };

export function CfoReportsPage() {
  return (
    <div className="flex flex-col h-full overflow-y-auto bg-zinc-50" data-testid="cfo-reports-page">
      {/* Page header */}
      <div className="px-6 pt-6 pb-4 bg-white border-b border-zinc-200 shrink-0">
        <h1 className="text-lg font-bold text-zinc-900">Reports</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Portfolio analytics — demo data</p>
      </div>

      {/* Chart grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-6">
        {/* AR Aging */}
        <ChartCard
          title="AR Aging"
          subtitle="Outstanding invoice amounts by days overdue (£k)"
          testId="chart-ar-aging"
        >
          <ReactECharts option={arAgingOption()} style={ECHART_STYLE} notMerge />
        </ChartCard>

        {/* CLTV Distribution */}
        <ChartCard
          title="CLTV Portfolio Distribution"
          subtitle="Customer lifetime value score tiers"
          testId="chart-cltv-distribution"
        >
          <ReactECharts option={cltvDonutOption()} style={ECHART_STYLE} notMerge />
        </ChartCard>

        {/* Revenue Trend */}
        <ChartCard
          title="Monthly Revenue Trend"
          subtitle="Collected vs outstanding over the past 12 months (£k)"
          testId="chart-revenue-trend"
        >
          <ReactECharts option={revenueTrendOption()} style={ECHART_STYLE} notMerge />
        </ChartCard>

        {/* Collections Recovery Rate */}
        <ChartCard
          title="Collections Recovery Rate"
          subtitle="Percentage recovered by month"
          testId="chart-recovery-rate"
        >
          <ReactECharts option={recoveryRateOption()} style={ECHART_STYLE} notMerge />
        </ChartCard>
      </div>
    </div>
  );
}
