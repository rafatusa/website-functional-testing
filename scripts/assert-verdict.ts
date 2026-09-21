import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Verify-stage gate. Runs in a DIFFERENT job from the test execution, so it
 * reads the verdict from the downloaded `execution-summary` artifact rather
 * than from a local filesystem that no longer exists.
 *
 * Exit 0 => every executed test passed. Exit 1 => the suite reported failures.
 */
function main(): void {
  const statusFile = resolve(process.env.VERDICT_DIR ?? 'verdict', 'status.json');
  const summaryFile = resolve(process.env.VERDICT_DIR ?? 'verdict', 'summary.md');

  if (!existsSync(statusFile)) {
    console.error(
      `Verdict file not found at ${statusFile}. The functional test stage did not publish a result, ` +
        'so the run cannot be certified as passing.',
    );
    process.exit(1);
  }

  const status = JSON.parse(readFileSync(statusFile, 'utf8')) as {
    exitCode?: number;
    passed?: boolean;
    startedAt?: string;
    finishedAt?: string;
  };

  if (existsSync(summaryFile)) {
    console.log(readFileSync(summaryFile, 'utf8'));
  }

  const exitCode = status.exitCode ?? 1;
  console.log('---');
  console.log(`Test run started : ${status.startedAt ?? 'unknown'}`);
  console.log(`Test run finished: ${status.finishedAt ?? 'unknown'}`);
  console.log(`Recorded exit code: ${exitCode}`);

  if (exitCode !== 0) {
    console.error(
      '\nFunctional tests reported failures. Download the "failure-evidence" artifact for ' +
        'screenshots, videos and Playwright traces, and "playwright-html-report" for the full report.',
    );
    process.exit(1);
  }

  console.log('\nVerified: all executed functional tests passed.');
}

main();
