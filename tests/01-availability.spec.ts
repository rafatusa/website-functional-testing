import { test, expect } from '../src/fixtures.js';
import {
  timedGoto,
  findBrokenLinks,
  findBrokenImages,
  formatIssues,
} from '../src/collectors.js';

test.describe('Homepage availability and validation', () => {
  test('homepage responds successfully', async ({ page, config }) => {
    test.skip(!config.tests.homepage, 'homepage checks disabled in config.yaml');

    const navigation = await timedGoto(page, config.baseUrl);
    expect(navigation.status, `HTTP status for ${config.baseUrl}`).toBeLessThan(400);
    await expect(page).toHaveTitle(/.+/);

    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length, 'homepage rendered no visible text').toBeGreaterThan(0);
  });

  test('homepage loads within the configured budget', async ({ page, config }) => {
    test.skip(!config.tests.homepage, 'homepage checks disabled in config.yaml');

    const navigation = await timedGoto(page, config.baseUrl);
    test.info().annotations.push({
      type: 'page-load',
      description: `${navigation.durationMs}ms (budget ${config.options.pageLoadBudgetMs}ms)`,
    });
    expect(
      navigation.durationMs,
      `homepage took ${navigation.durationMs}ms, budget is ${config.options.pageLoadBudgetMs}ms`,
    ).toBeLessThanOrEqual(config.options.pageLoadBudgetMs);
  });

  test('homepage reports no JavaScript console errors', async ({ page, config, consoleIssues }) => {
    test.skip(!config.tests.homepage, 'homepage checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    await page.waitForTimeout(2000);

    if (consoleIssues.length > 0) {
      const detail = formatIssues(consoleIssues);
      test.info().annotations.push({ type: 'console-errors', description: detail });
      if (config.options.failOnConsoleErrors) {
        expect(consoleIssues, `console errors detected:\n${detail}`).toHaveLength(0);
      }
    }
  });

  test('homepage has no broken links', async ({ page, config }) => {
    test.skip(!config.tests.links, 'link checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const broken = await findBrokenLinks(page, config);
    expect(broken, `broken links found:\n${formatIssues(broken)}`).toHaveLength(0);
  });

  test('homepage has no broken images', async ({ page, config }) => {
    test.skip(!config.tests.links, 'link checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    await page.waitForLoadState('load').catch(() => undefined);
    const broken = await findBrokenImages(page, config);
    expect(broken, `broken images found:\n${formatIssues(broken)}`).toHaveLength(0);
  });
});
