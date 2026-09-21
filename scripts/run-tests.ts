import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Runs the Playwright suite and RECORDS its exit code instead of propagating it.
 *
 * Why: the platform pipeline spec forbids `continue-on-error`, so a non-zero
 * exit here would skip the reporting/upload stage and destroy exactly the
 * evidence a failure needs. The verify stage reads reports/status.json and
 * re-asserts this code AFTER the artifacts are uploaded, so a failing site
 * still turns the run red — it just does so with the screenshots attached.
 */
function main(): void {
  const reportsDir = resolve('reports');
  mkdirSync(reportsDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const result = spawnSync('npx', ['playwright', 'test'], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });

  const exitCode = result.status ?? 1;
  const status = {
    exitCode,
    passed: exitCode === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    signal: result.signal ?? null,
  };

  writeFileSync(resolve(reportsDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');

  if (exitCode === 0) {
    console.log('\nFunctional test run completed: all executed tests passed.');
  } else {
    console.log(
      `\nFunctional test run completed with failures (exit code ${exitCode}). ` +
        'Reports and failure evidence will be collected and uploaded, then the run will be marked failed.',
    );
  }

  // Always exit 0 — the verify stage owns the final verdict.
  process.exit(0);
}

main();
