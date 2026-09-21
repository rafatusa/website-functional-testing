import { test, expect } from '../src/fixtures.js';
import { timedGoto } from '../src/collectors.js';

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'tablet', width: 820, height: 1180 },
  { label: 'mobile', width: 390, height: 844 },
];

test.describe('Responsive viewports', () => {
  for (const viewport of VIEWPORTS) {
    test(`renders without horizontal overflow at ${viewport.label} (${viewport.width}px)`, async ({
      page,
      config,
    }) => {
      test.skip(!config.tests.responsive, 'responsive checks disabled in config.yaml');

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const navigation = await timedGoto(page, config.baseUrl);
      expect(navigation.status, `HTTP ${navigation.status} at ${viewport.label}`).toBeLessThan(400);

      await page.waitForTimeout(1000);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);

      test.info().annotations.push({
        type: 'viewport',
        description: `${viewport.label}: scrollWidth=${scrollWidth} viewport=${viewport.width}`,
      });

      // A small tolerance absorbs scrollbar and sub-pixel rounding differences.
      expect(
        scrollWidth,
        `content overflows horizontally at ${viewport.width}px (scrollWidth ${scrollWidth})`,
      ).toBeLessThanOrEqual(viewport.width + 24);
    });
  }

  test('body content is visible on a mobile viewport', async ({ page, config }) => {
    test.skip(!config.tests.responsive, 'responsive checks disabled in config.yaml');

    await page.setViewportSize({ width: 390, height: 844 });
    await timedGoto(page, config.baseUrl);

    const body = page.locator('body');
    await expect(body).toBeVisible();
    const text = await body.innerText();
    expect(text.trim().length, 'mobile viewport rendered no visible text').toBeGreaterThan(0);
  });
});
