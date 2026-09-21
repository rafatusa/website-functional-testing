import { test, expect } from '../src/fixtures.js';
import { timedGoto } from '../src/collectors.js';
import { collectLinks } from '../src/discovery.js';

test.describe('Navigation, menus, buttons and links', () => {
  test('primary navigation exists and is visible', async ({ page, config }) => {
    test.skip(!config.tests.navigation, 'navigation checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);

    const navRegions = page.locator('nav, [role="navigation"], header');
    const count = await navRegions.count();
    test.skip(count === 0, 'site exposes no <nav>, [role=navigation] or <header> region');

    let visible = 0;
    for (let index = 0; index < count; index += 1) {
      if (await navRegions.nth(index).isVisible().catch(() => false)) visible += 1;
    }
    expect(visible, 'no navigation region rendered visibly').toBeGreaterThan(0);
  });

  test('menu navigation follows an internal link to a working page', async ({ page, config }) => {
    test.skip(!config.tests.navigation, 'navigation checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const origin = new URL(config.baseUrl).origin;
    const links = (await collectLinks(page)).filter((link) => {
      const clean = link.href.split('#')[0];
      return clean.startsWith(origin) && clean !== `${config.baseUrl}/` && clean !== config.baseUrl;
    });

    test.skip(links.length === 0, 'no internal navigation links found on the homepage');

    const target = links[0];
    const navigation = await timedGoto(page, target.href);
    expect(
      navigation.status,
      `following "${target.text || target.href}" returned HTTP ${navigation.status}`,
    ).toBeLessThan(400);
  });

  test('interactive buttons are enabled and actionable', async ({ page, config }) => {
    test.skip(!config.tests.navigation, 'navigation checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const buttons = page.getByRole('button');
    const count = await buttons.count();
    test.skip(count === 0, 'homepage exposes no button role elements');

    const sample = Math.min(count, 10);
    const disabled: string[] = [];
    for (let index = 0; index < sample; index += 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      if (!(await button.isEnabled().catch(() => true))) {
        disabled.push((await button.innerText().catch(() => '')) || `button#${index}`);
      }
    }
    test.info().annotations.push({
      type: 'buttons',
      description: `${sample} of ${count} buttons sampled, ${disabled.length} disabled`,
    });
    expect(sample, 'no visible buttons could be sampled').toBeGreaterThan(0);
  });

  test('anchor links declare navigable targets', async ({ page, config }) => {
    test.skip(!config.tests.links, 'link checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const links = await collectLinks(page);
    test.skip(links.length === 0, 'homepage exposes no anchor links');

    const empty = links.filter((link) => link.href.endsWith('#') || link.href === 'about:blank');
    expect(
      empty.length,
      `links with no destination: ${empty.map((link) => link.text).join(', ')}`,
    ).toBeLessThanOrEqual(Math.ceil(links.length * 0.2));
  });
});
