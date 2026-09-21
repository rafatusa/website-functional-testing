import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PlaywrightTestResult {
  status?: string;
  duration?: number;
  error?: { message?: string };
}

interface PlaywrightTest {
  projectName?: string;
  status?: string;
  results?: PlaywrightTestResult[];
  annotations?: Array<{ type: string; description?: string }>;
}

interface PlaywrightSpec {
  title?: string;
  ok?: boolean;
  tests?: PlaywrightTest[];
}

interface PlaywrightSuite {
  title?: string;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

interface PlaywrightReport {
  suites?: PlaywrightSuite[];
  stats?: { startTime?: string; duration?: number };
}

interface Row {
  suite: string;
  title: string;
  project: string;
  status: string;
  durationMs: number;
  reason: string;
}

function flatten(suite: PlaywrightSuite, trail: string[], rows: Row[]): void {
  const path = suite.title ? [...trail, suite.title] : trail;

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const last = (test.results ?? [])[test.results!.length - 1];
      const status = (test.status ?? last?.status ?? 'unknown').toLowerCase();
      const annotation = (test.annotations ?? []).find((entry) => entry.type === 'skip');
      rows.push({
        suite: path.join(' › ') || 'suite',
        title: spec.title ?? 'untitled test',
        project: test.projectName ?? 'default',
        status,
        durationMs: last?.duration ?? 0,
        reason: (annotation?.description ?? last?.error?.message ?? '').split('\n')[0].slice(0, 180),
      });
    }
  }

  for (const child of suite.suites ?? []) {
    flatten(child, path, rows);
  }
}

function icon(status: string): string {
  if (status === 'expected' || status === 'passed') return 'PASS';
  if (status === 'skipped') return 'SKIP';
  if (status === 'flaky') return 'FLAKY';
  return 'FAIL';
}

function bucket(status: string): 'passed' | 'failed' | 'skipped' | 'flaky' {
  if (status === 'expected' || status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  if (status === 'flaky') return 'flaky';
  return 'failed';
}

function main(): void {
  const reportsDir = resolve('reports');
  mkdirSync(reportsDir, { recursive: true });

  const resultsFile = resolve(reportsDir, 'results.json');
  const statusFile = resolve(reportsDir, 'status.json');

  const lines: string[] = ['# Website Functional Testing — Execution Summary', ''];
  const baseUrl = process.env.SITE_BASE_URL ?? readBaseUrlFromConfig();
  lines.push(`**Target:** ${baseUrl}`, '');

  let rows: Row[] = [];
  let totalDuration = 0;

  if (existsSync(resultsFile)) {
    const report = JSON.parse(readFileSync(resultsFile, 'utf8')) as PlaywrightReport;
    for (const suite of report.suites ?? []) {
      flatten(suite, [], rows);
    }
    totalDuration = report.stats?.duration ?? 0;
  } else {
    lines.push('> No Playwright JSON results were produced — the test stage did not run to completion.', '');
  }

  const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const row of rows) {
    counts[bucket(row.status)] += 1;
  }
  const executed = counts.passed + counts.failed + counts.flaky;
  const passRate = executed > 0 ? ((counts.passed + counts.flaky) / executed) * 100 : 0;

  lines.push('## Pass/Fail Statistics', '');
  lines.push('| Metric | Value |', '| --- | --- |');
  lines.push(`| Total tests | ${rows.length} |`);
  lines.push(`| Passed | ${counts.passed} |`);
  lines.push(`| Failed | ${counts.failed} |`);
  lines.push(`| Flaky (passed on retry) | ${counts.flaky} |`);
  lines.push(`| Skipped (feature absent or disabled) | ${counts.skipped} |`);
  lines.push(`| Pass rate (of executed) | ${passRate.toFixed(1)}% |`);
  lines.push(`| Total duration | ${(totalDuration / 1000).toFixed(1)}s |`);
  lines.push('');

  const failures = rows.filter((row) => bucket(row.status) === 'failed');
  if (failures.length > 0) {
    lines.push('## Failures', '');
    lines.push('| Test | Project | Reason |', '| --- | --- | --- |');
    for (const row of failures) {
      lines.push(`| ${escape(row.title)} | ${row.project} | ${escape(row.reason) || 'see HTML report'} |`);
    }
    lines.push('');
    lines.push('Screenshots, videos and traces for these tests are in the **failure-evidence** artifact.', '');
  }

  const skipped = rows.filter((row) => bucket(row.status) === 'skipped');
  if (skipped.length > 0) {
    lines.push('## Skipped Checks', '');
    lines.push('| Test | Project | Why |', '| --- | --- | --- |');
    for (const row of skipped) {
      lines.push(`| ${escape(row.title)} | ${row.project} | ${escape(row.reason) || 'feature not present'} |`);
    }
    lines.push('');
  }

  if (rows.length > 0) {
    lines.push('## Full Results', '');
    lines.push('| Result | Test | Project | Duration |', '| --- | --- | --- | --- |');
    for (const row of rows) {
      lines.push(
        `| ${icon(row.status)} | ${escape(row.title)} | ${row.project} | ${(row.durationMs / 1000).toFixed(1)}s |`,
      );
    }
    lines.push('');
  }

  lines.push('## Artifacts', '');
  lines.push('- `playwright-html-report` — full interactive HTML report');
  lines.push('- `junit-xml-report` — JUnit XML for CI dashboards');
  lines.push('- `execution-summary` — this summary');
  lines.push('- `failure-evidence` — screenshots, videos and Playwright traces for failed tests');
  lines.push('');

  const summaryPath = resolve(reportsDir, 'summary.md');
  writeFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(lines.join('\n'));

  // Re-assert the verdict recorded by run-tests.ts, now that artifacts exist.
  let recordedExit = 0;
  if (existsSync(statusFile)) {
    const status = JSON.parse(readFileSync(statusFile, 'utf8')) as { exitCode?: number };
    recordedExit = status.exitCode ?? 0;
  } else {
    console.error('\nreports/status.json missing — the test stage did not record a verdict.');
    recordedExit = 1;
  }

  if (recordedExit !== 0) {
    console.error(
      `\nFunctional tests reported failures (${counts.failed} failed). Marking the workflow as failed.`,
    );
    process.exit(1);
  }
  console.log('\nAll executed functional tests passed.');
}

function escape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function readBaseUrlFromConfig(): string {
  try {
    const raw = readFileSync(resolve('config.yaml'), 'utf8');
    const match = raw.match(/^baseUrl:\s*(.+)$/m);
    return match ? match[1].trim() : 'not configured';
  } catch {
    return 'not configured';
  }
}

main();
