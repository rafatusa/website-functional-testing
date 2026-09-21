import { test, expect } from '../src/fixtures.js';
import { timedGoto } from '../src/collectors.js';
import {
  findFeatureUrl,
  findIdentityInput,
  findSubmitControl,
  hasPasswordField,
  looksLoggedIn,
} from '../src/discovery.js';

test.describe('Authentication: login, logout and session', () => {
  test('login page is reachable and exposes a credential form', async ({ page, config }) => {
    test.skip(!config.tests.login, 'login checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const loginUrl = await findFeatureUrl(page, config, 'login');
    test.skip(!loginUrl, 'no login page discovered on this site');

    const navigation = await timedGoto(page, loginUrl as string);
    expect(navigation.status, `login page returned HTTP ${navigation.status}`).toBeLessThan(400);
    expect(await hasPasswordField(page), 'login page exposes no password field').toBe(true);
  });

  test('valid credentials establish an authenticated session', async ({ page, config }) => {
    test.skip(!config.tests.login, 'login checks disabled in config.yaml');
    test.skip(!config.hasCredentials, 'no credentials supplied — set SITE_USERNAME / SITE_PASSWORD');

    await timedGoto(page, config.baseUrl);
    const loginUrl = await findFeatureUrl(page, config, 'login');
    test.skip(!loginUrl, 'no login page discovered on this site');

    await timedGoto(page, loginUrl as string);
    const identity = await findIdentityInput(page);
    const password = page.locator('input[type="password"]').first();
    const submit = await findSubmitControl(page);

    test.skip(!identity || !submit, 'login form fields could not be located');

    await identity!.fill(config.credentials.username);
    await password.fill(config.credentials.password);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => undefined),
      submit!.click(),
    ]);
    await page.waitForTimeout(2000);

    expect(await looksLoggedIn(page), 'login did not produce an authenticated session').toBe(true);
  });

  test('invalid credentials are rejected', async ({ page, config }) => {
    test.skip(!config.tests.login, 'login checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const loginUrl = await findFeatureUrl(page, config, 'login');
    test.skip(!loginUrl, 'no login page discovered on this site');

    await timedGoto(page, loginUrl as string);
    const identity = await findIdentityInput(page);
    const password = page.locator('input[type="password"]').first();
    const submit = await findSubmitControl(page);
    test.skip(!identity || !submit, 'login form fields could not be located');

    await identity!.fill('udap-invalid-user@example.invalid');
    await password.fill('ThisPasswordIsIntentionallyWrong1234');
    await submit!.click();
    await page.waitForTimeout(2500);

    expect(await looksLoggedIn(page), 'invalid credentials were accepted').toBe(false);
  });

  test('logout terminates the session', async ({ page, config }) => {
    test.skip(!config.tests.logout, 'logout checks disabled in config.yaml');
    test.skip(!config.hasCredentials, 'no credentials supplied — logout cannot be exercised');

    await timedGoto(page, config.baseUrl);
    const loginUrl = await findFeatureUrl(page, config, 'login');
    test.skip(!loginUrl, 'no login page discovered on this site');

    await timedGoto(page, loginUrl as string);
    const identity = await findIdentityInput(page);
    const password = page.locator('input[type="password"]').first();
    const submit = await findSubmitControl(page);
    test.skip(!identity || !submit, 'login form fields could not be located');

    await identity!.fill(config.credentials.username);
    await password.fill(config.credentials.password);
    await submit!.click();
    await page.waitForTimeout(2500);
    test.skip(!(await looksLoggedIn(page)), 'login did not succeed, so logout cannot be tested');

    const logoutLink = page.getByRole('link', { name: /log ?out|sign ?out/i }).first();
    const logoutButton = page.getByRole('button', { name: /log ?out|sign ?out/i }).first();

    if ((await logoutLink.count()) > 0) {
      await logoutLink.click();
    } else if ((await logoutButton.count()) > 0) {
      await logoutButton.click();
    } else {
      const logoutUrl = await findFeatureUrl(page, config, 'logout');
      test.skip(!logoutUrl, 'no logout control or URL discovered');
      await timedGoto(page, logoutUrl as string);
    }

    await page.waitForTimeout(2000);
    expect(await looksLoggedIn(page), 'session survived logout').toBe(false);
  });

  test('session state does not survive a cleared context', async ({ page, config, browser }) => {
    test.skip(!config.tests.sessionTimeout, 'session timeout checks disabled in config.yaml');
    test.skip(!config.hasCredentials, 'no credentials supplied — session lifetime cannot be tested');

    await timedGoto(page, config.baseUrl);
    const loginUrl = await findFeatureUrl(page, config, 'login');
    test.skip(!loginUrl, 'no login page discovered on this site');

    await timedGoto(page, loginUrl as string);
    const identity = await findIdentityInput(page);
    const password = page.locator('input[type="password"]').first();
    const submit = await findSubmitControl(page);
    test.skip(!identity || !submit, 'login form fields could not be located');

    await identity!.fill(config.credentials.username);
    await password.fill(config.credentials.password);
    await submit!.click();
    await page.waitForTimeout(2500);
    test.skip(!(await looksLoggedIn(page)), 'login did not succeed, so session cannot be tested');

    // Simulate idleness, then confirm a brand-new context is anonymous:
    // a session that leaks across contexts means auth is not cookie/token bound.
    await page.waitForTimeout(config.options.sessionIdleSeconds * 1000);

    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
    const leaked = await looksLoggedIn(freshPage);
    await freshContext.close();

    expect(leaked, 'a fresh browser context was already authenticated').toBe(false);
  });
});
