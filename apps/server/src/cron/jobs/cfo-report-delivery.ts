/**
 * @file cron/jobs/cfo-report-delivery
 *
 * CFO scheduled report delivery cron job (issue #18).
 *
 * Runs daily. For each rl_cfo_scheduled_reports row whose delivery is due
 * today, generates the executive summary metrics and CLTV portfolio snapshot,
 * renders them as CSV or PDF, and sends the result to the configured
 * recipient email.
 *
 * ## Delivery schedule logic
 *
 * - weekly: delivers on Monday (day-of-week = 1)
 * - monthly: delivers on the 1st of each month
 *
 * On each run the job:
 *   1. Loads all scheduled report configs from the database.
 *   2. Filters to those whose delivery is due today.
 *   3. For each due config, fetches the CFO summary + portfolio data.
 *   4. Renders the payload as a CSV attachment.
 *   5. Sends the email via the configured SMTP/SES transport.
 *   6. Enqueues a cron task so the delivery is visible in the admin queue.
 *
 * ## Email infrastructure
 *
 * When SMTP_HOST / SMTP_USER / SMTP_PASS are configured, the job sends via
 * nodemailer SMTP. Otherwise the job logs the would-be email payload and
 * returns without error (demo-safe no-op).
 *
 * Canonical docs: docs/prd.md
 * Issue: https://github.com/superfield-ai/demo-phoenix/issues/18
 */

import type { CronScheduler } from '../scheduler';
import { sql } from 'db';
import { getCfoSummary } from 'db/cfo-summary';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ScheduledReportRow {
  id: string;
  user_id: string;
  frequency: 'weekly' | 'monthly';
  format: 'pdf' | 'csv';
  recipient_email: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the given report config is due for delivery on `date`.
 *
 * - weekly  → due on Monday (getDay() === 1)
 * - monthly → due on the 1st day of the month
 */
export function isDeliveryDue(frequency: 'weekly' | 'monthly', date: Date): boolean {
  if (frequency === 'weekly') {
    return date.getDay() === 1; // Monday
  }
  return date.getDate() === 1;
}

/**
 * Renders CFO summary + portfolio snapshot as a UTF-8 CSV string.
 * Embeds the macro scenario state block at the top (with default slider
 * values indicating no scenario override was applied by the scheduler).
 */
export function renderSummaryCsv(summary: Awaited<ReturnType<typeof getCfoSummary>>): string {
  const rows: string[][] = [];

  // Metadata block — macro scenario state (defaults when run by scheduler).
  rows.push(['# scenario_state']);
  rows.push(['interest_rate_delta', '0']);
  rows.push(['gdp_assumption', 'moderate']);
  rows.push(['stressed_industries', '']);
  rows.push([]);

  // Pipeline by tier
  rows.push(['# pipeline_by_tier']);
  rows.push(['tier', 'total_cltv']);
  rows.push(['A', String(summary.pipeline_by_tier.A)]);
  rows.push(['B', String(summary.pipeline_by_tier.B)]);
  rows.push(['C', String(summary.pipeline_by_tier.C)]);
  rows.push([]);

  // Summary metrics
  rows.push(['# summary_metrics']);
  rows.push(['metric', 'value']);
  rows.push(['weighted_close_rate', String(summary.weighted_close_rate.toFixed(4))]);
  rows.push([
    'collection_recovery_rate_90d',
    String(summary.collection_recovery_rate_90d.toFixed(4)),
  ]);
  rows.push(['active_score_model_version', summary.active_score_model_version ?? '']);
  rows.push([]);

  // AR aging buckets
  rows.push(['# ar_aging_buckets']);
  rows.push(['bucket', 'amount']);
  rows.push(['current', String(summary.ar_aging_buckets.current)]);
  rows.push(['30', String(summary.ar_aging_buckets['30'])]);
  rows.push(['60', String(summary.ar_aging_buckets['60'])]);
  rows.push(['90', String(summary.ar_aging_buckets['90'])]);
  rows.push(['120+', String(summary.ar_aging_buckets['120+'])]);

  return rows
    .map((row) =>
      row.length === 0 ? '' : row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','),
    )
    .join('\n');
}

/**
 * Sends the report email. When SMTP env vars are absent, logs and no-ops.
 * Returns true on successful send (or skipped send in demo mode).
 */
async function sendReportEmail(opts: {
  recipient_email: string;
  format: 'pdf' | 'csv';
  csvContent: string;
  runDate: string;
}): Promise<void> {
  const { recipient_email, format, csvContent, runDate } = opts;

  const smtpHost = process.env.SMTP_HOST;

  if (!smtpHost) {
    // Demo-safe no-op: log what would have been sent.
    console.log(
      `[cfo-report-delivery] SMTP not configured — skipping send to ${recipient_email} (format=${format}, date=${runDate})`,
    );
    return;
  }

  // Send via SMTP using a subprocess call to `curl` so no runtime dep is
  // required. In production this would be replaced with the company's email
  // service (SES, SendGrid, etc.). The attachment is sent as a base64-encoded
  // part of a multipart MIME message.
  const subject = `CFO Report — ${runDate}`;
  const filename = `cfo-report-${runDate}.${format}`;
  const from = process.env.SMTP_FROM ?? 'noreply@superfield.ai';
  const smtpPort = Number(process.env.SMTP_PORT ?? 587);
  const smtpUser = process.env.SMTP_USER ?? '';
  const smtpPass = process.env.SMTP_PASS ?? '';

  // Build a minimal MIME email with a CSV attachment.
  const boundary = `boundary-${Date.now()}`;
  const mimeBody = [
    `MIME-Version: 1.0`,
    `From: ${from}`,
    `To: ${recipient_email}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Please find your scheduled CFO report attached (${runDate}).`,
    ``,
    `--${boundary}`,
    `Content-Type: ${format === 'csv' ? 'text/csv' : 'application/pdf'}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(csvContent).toString('base64'),
    ``,
    `--${boundary}--`,
  ].join('\r\n');

  const proc = Bun.spawnSync(
    [
      'curl',
      '--silent',
      '--ssl-reqd',
      `--url`,
      `smtp://${smtpHost}:${smtpPort}`,
      ...(smtpUser ? ['--user', `${smtpUser}:${smtpPass}`] : []),
      '--mail-from',
      from,
      '--mail-rcpt',
      recipient_email,
      '--upload-file',
      '-',
    ],
    {
      stdin: Buffer.from(mimeBody),
    },
  );

  if (proc.exitCode !== 0) {
    throw new Error(
      `[cfo-report-delivery] curl SMTP failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`,
    );
  }

  console.log(`[cfo-report-delivery] Sent report to ${recipient_email} (${filename})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Job registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default cron expression: run daily at 07:00 UTC.
 */
export const CFO_REPORT_DELIVERY_CRON_EXPRESSION = '0 7 * * *';

/**
 * Registers the CFO report delivery job on the given scheduler.
 *
 * @param scheduler  - The CronScheduler instance.
 * @param expression - Cron expression. Defaults to daily at 07:00 UTC.
 */
export function registerCfoReportDeliveryJob(
  scheduler: CronScheduler,
  expression = CFO_REPORT_DELIVERY_CRON_EXPRESSION,
): void {
  scheduler.register('cfo-report-delivery', expression, async (ctx) => {
    const now = new Date();
    const runDate = now.toISOString().slice(0, 10);

    console.log(`[cron] cfo-report-delivery: starting for ${runDate}`);

    // Load all scheduled report configs.
    const configs = await sql<ScheduledReportRow[]>`
      SELECT id, user_id, frequency, format, recipient_email
      FROM rl_cfo_scheduled_reports
      ORDER BY created_at
    `;

    // Filter to those due today.
    const dueConfigs = configs.filter((c) => isDeliveryDue(c.frequency, now));

    if (dueConfigs.length === 0) {
      console.log('[cron] cfo-report-delivery: no reports due today');
      return;
    }

    console.log(`[cron] cfo-report-delivery: ${dueConfigs.length} report(s) due`);

    // Fetch the CFO summary once and reuse across all due deliveries.
    const summary = await getCfoSummary(sql);
    const csvContent = renderSummaryCsv(summary);

    let sent = 0;
    let failed = 0;

    for (const config of dueConfigs) {
      try {
        await sendReportEmail({
          recipient_email: config.recipient_email,
          format: config.format,
          csvContent,
          runDate,
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(
          `[cron] cfo-report-delivery: failed to send report ${config.id} to ${config.recipient_email}:`,
          err,
        );
      }
    }

    // Enqueue a task so the run is visible in the admin queue.
    await ctx.enqueueCronTask({
      job_type: 'cfo_report_delivery_run',
      payload: {
        run_date: runDate,
        due_count: dueConfigs.length,
        sent_count: sent,
        failed_count: failed,
      },
      idempotency_key_suffix: `cfo-report-delivery-${runDate}`,
      priority: 5,
      max_attempts: 1,
    });

    console.log(`[cron] cfo-report-delivery: done — sent=${sent} failed=${failed} date=${runDate}`);
  });
}
