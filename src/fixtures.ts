import { test as base, expect } from '@playwright/test';
import { loadConfig, type SiteConfig } from './config.js';
import { watchConsole, watchResponses, type ConsoleIssue, type ResourceIssue } from './collectors.js';

export interface Fixtures {
  config: SiteConfig;
  consoleIssues: ConsoleIssue[];
  httpIssues: ResourceIssue[];
}

/**
 * Every spec gets the parsed config plus console/HTTP collectors already
 * attached to the page, so validation data is gathered on all navigations.
 */
export const test = base.extend<Fixtures>({
  config: async ({}, use) => {
    await use(loadConfig());
  },
  consoleIssues: async ({ page }, use) => {
    const issues = watchConsole(page);
    await use(issues);
  },
  httpIssues: async ({ page }, use) => {
    const issues = watchResponses(page);
    await use(issues);
  },
});

export { expect };
