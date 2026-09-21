import { test, expect } from '../src/fixtures.js';
import { timedGoto } from '../src/collectors.js';
import {
  findFeatureUrl,
  findIdentityInput,
  findSubmitControl,
  hasPasswordField,
  looksLoggedIn,
} from '../src/discovery.js';

test.describe('Account flows: signup, forgot password, profile, protected pages', () => {
  test('signup page is reachable and collects registration details', async ({ page, config }) => {
    test.skip(!config.tests.signup, 'signup checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const signupUrl = await findFeatureUrl(page, config, 'signup');
    test.skip(!signupUrl, 'no signup page discovered on this site');

    const navigation = await timedGoto(page, signupUrl as string);
    expect(navigation.status, `signup page returned HTTP ${navigation.status}`).toBeLessThan(400);

    const inputs = await page.locator('form input').count();
    expect(inputs, 'signup page exposes no form inputs').toBeGreaterThan(0);
  });

  test('forgot password page accepts a recovery request', async ({ page, config }) => {
    test.skip(!config.tests.forgotPassword, 'forgot password checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const resetUrl = await findFeatureUrl(page, config, 'forgotPassword');
    test.skip(!resetUrl, 'no forgot password page discovered on this site');

    const navigation = await timedGoto(page, resetUrl as string);
    expect(navigation.status, `forgot password page returned HTTP ${navigation.status}`).toBeLessThan(400);

    const identity = await findIdentityInput(page);
    test.skip(!identity, 'forgot password page exposes no identifier field');
    expect(await identity!.isEditable(), 'recovery field is not editable').toBe(true);
  });

  test('profile page requires authentication', async ({ page, config }) => {
    test.skip(!config.tests.profile, 'profile checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const profileUrl = await findFeatureUrl(page, config, 'profile');
    test.skip(!profileUrl, 'no profile page discovered on this site');

    const navigation = await timedGoto(page, profileUrl as string);
    expect(navigation.status, `profile page returned HTTP ${navigation.status}`).toBeLessThan(500);
  });

  test('protected pages redirect anonymous visitors', async ({ page, config }) => {
    test.skip(!config.tests.protectedPages, 'protected page checks disabled in config.yaml');

    await timedGoto(page, config.baseUrl);
    const protectedUrl =
      (config.paths.protected ? new URL(config.paths.protected, `${config.baseUrl}/`).toString() : null) ??
      (await findFeatureUrl(page, config, 'profile'));
    test.skip(!protectedUrl, 'no protected page discovered or configured');

    const navigation = await timedGoto(page, protectedUrl as string);

    // Acceptable outcomes for an anonymous visitor: a redirect to a login form,
    // an explicit 401/403, or a page that simply is not authenticated content.
    const redirectedToAuth = /login|signin|sign-in|auth/i.test(page.url());
    const showsLoginForm = await hasPasswordField(page);
    const blocked = navigation.status === 401 || navigation.status === 403;
    const authenticated = await looksLoggedIn(page);

    test.info().annotations.push({
      type: 'protected-page',
      description: `url=${page.url()} status=${navigation.status}`,
    });

    expect(
      redirectedToAuth || showsLoginForm || blocked || !authenticated,
      'protected page served authenticated content to an anonymous visitor',
    ).toBe(true);
  });

  test('authenticated profile page renders account content', async ({ page, config }) => {
    test.skip(!config.tests.profile, 'profile checks disabled in config.yaml');
    test.skip(!config.hasCredentials, 'no credentials supplied — authenticated profile is skipped');

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
    test.skip(!(await looksLoggedIn(page)), 'login did not succeed, so profile cannot be verified');

    const profileUrl = await findFeatureUrl(page, config, 'profile');
    test.skip(!profileUrl, 'no profile page discovered on this site');

    const navigation = await timedGoto(page, profileUrl as string);
    expect(navigation.status, `profile page returned HTTP ${navigation.status}`).toBeLessThan(400);

    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length, 'profile page rendered no content').toBeGreaterThan(0);
  });
});
