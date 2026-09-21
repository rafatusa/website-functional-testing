import { test, expect } from '../src/fixtures.js';
import { timedGoto } from '../src/collectors.js';
import {
  activateAuthPanel,
  describeFormState,
  findEmailInput,
  findFeatureUrl,
  findSearchInput,
  findSubmitControl,
} from '../src/discovery.js';

test.describe('Search and form validation', () => {
  test('search returns a result page', async ({ page, config }) => {
    test.skip(!config.tests.search, 'search checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    let input = await findSearchInput(page);

    if (!input) {
      const searchUrl = await findFeatureUrl(page, config, 'search');
      test.skip(!searchUrl, 'no search input or search page discovered on this site');
      await timedGoto(page, searchUrl as string);
      input = await findSearchInput(page);
    }
    test.skip(!input, 'search page exposes no usable search input');

    const before = page.url();
    await input!.fill('test');
    await input!.press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForTimeout(2500);

    const changed = page.url() !== before;
    const bodyText = await page.locator('body').innerText();
    test.info().annotations.push({ type: 'search', description: `url=${page.url()}` });

    expect(
      changed || bodyText.toLowerCase().includes('result') || bodyText.toLowerCase().includes('test'),
      'search produced neither navigation nor visible results',
    ).toBe(true);
  });

  test('required fields block an empty submission', async ({ page, config }) => {
    test.skip(!config.tests.forms, 'form validation checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    let formCount = await page.locator('form').count();

    if (formCount === 0) {
      const loginUrl = await findFeatureUrl(page, config, 'login');
      test.skip(!loginUrl, 'no forms discovered anywhere on this site');
      await timedGoto(page, loginUrl as string);
      await activateAuthPanel(page);
      formCount = await page.locator('form').count();
    }
    test.skip(formCount === 0, 'no <form> elements on this site (inputs may be wired via JS)');

    const requiredFields = page.locator('form input[required], form select[required], form textarea[required]');
    const requiredCount = await requiredFields.count();
    test.skip(requiredCount === 0, 'no client-side required fields to validate');

    const submit = await findSubmitControl(page);
    test.skip(!submit, 'form exposes no submit control');

    const urlBefore = page.url();
    await submit!.click();
    await page.waitForTimeout(1500);

    const stillOnPage = page.url() === urlBefore;
    const invalid = await page.evaluate(
      () => document.querySelectorAll('form :invalid').length,
    );

    expect(
      stillOnPage || invalid > 0,
      'empty submission of a form with required fields was accepted',
    ).toBe(true);
  });

  test('email fields reject malformed input', async ({ page, config }) => {
    test.skip(!config.tests.forms, 'form validation checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    // Resolve the first USABLE email input, not the first in DOM order: pages
    // that mount every panel at once expose collapsed 0x0 email fields from
    // inactive forms ahead of the live one.
    let field = await findEmailInput(page);

    if (!field) {
      const loginUrl = await findFeatureUrl(page, config, 'login');
      test.skip(!loginUrl, 'no email inputs discovered on this site');
      await timedGoto(page, loginUrl as string);
      await activateAuthPanel(page);
      field = await findEmailInput(page);
    }

    if (!field) {
      test.info().annotations.push({
        type: 'email-validation-diagnostic',
        description: await describeFormState(page),
      });
    }
    test.skip(!field, 'no usable email input discovered on this site');

    await field!.fill('not-a-valid-email');
    const valid = await field!.evaluate((element) => (element as HTMLInputElement).checkValidity());
    expect(valid, 'an invalid email address passed native validation').toBe(false);
  });
});
