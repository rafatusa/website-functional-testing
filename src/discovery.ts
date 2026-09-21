import type { Page, Locator } from '@playwright/test';
import type { SiteConfig } from './config.js';
import { resolveHint } from './config.js';

export type Feature = 'login' | 'signup' | 'forgotPassword' | 'profile' | 'search' | 'logout';

/**
 * How long to wait for a client-side router to mount a form after navigation.
 *
 * Single-page apps (hash routes like `/#login`, or history-API routes) return
 * the same HTML shell for every URL and render the real form only after the
 * router reacts. Counting inputs immediately after `goto` therefore sees zero
 * of them and produces a false "feature absent" verdict. Every form lookup in
 * this module waits for a mount before reporting nothing found.
 */
const FORM_MOUNT_TIMEOUT_MS = 8000;
const FORM_POLL_INTERVAL_MS = 250;

/**
 * Short timeout for "is this control here right now?" questions, where waiting
 * the full mount budget would be wrong. `looksLoggedIn` uses it: a page with no
 * password field is the EXPECTED state after login, so blocking 8s on every
 * check would add minutes to the suite for no signal.
 */
const PRESENCE_CHECK_TIMEOUT_MS = 1000;

/**
 * Keyword sets used to recognise a feature from link hrefs and visible text.
 * Deliberately broad: the goal is "does this site appear to have X?", and a
 * false negative only causes a graceful skip.
 */
const HREF_KEYWORDS: Record<Feature, string[]> = {
  login: ['login', 'log-in', 'signin', 'sign-in', 'auth', 'account/login', 'session/new'],
  signup: ['signup', 'sign-up', 'register', 'registration', 'join', 'create-account', 'users/new'],
  forgotPassword: ['forgot', 'reset-password', 'password/reset', 'password_reset', 'recover'],
  profile: ['profile', 'account', 'my-account', 'settings', 'dashboard', 'me'],
  search: ['search', 'find', '?q=', 's='],
  logout: ['logout', 'log-out', 'signout', 'sign-out', 'session/destroy'],
};

const TEXT_KEYWORDS: Record<Feature, string[]> = {
  login: ['log in', 'login', 'sign in', 'signin'],
  signup: ['sign up', 'signup', 'register', 'create account', 'get started', 'join'],
  forgotPassword: ['forgot password', 'forgot your password', 'reset password', 'lost password'],
  profile: ['profile', 'my account', 'account', 'dashboard', 'settings'],
  search: ['search'],
  logout: ['log out', 'logout', 'sign out', 'signout'],
};

export interface DiscoveredLink {
  href: string;
  text: string;
}

/** Collects same-origin candidate links from the current page. */
export async function collectLinks(page: Page): Promise<DiscoveredLink[]> {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return anchors
      .map((anchor) => {
        const element = anchor as HTMLAnchorElement;
        return {
          href: element.href,
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
        };
      })
      .filter((link) => link.href.startsWith('http'));
  });
}

function matches(link: DiscoveredLink, feature: Feature): boolean {
  const href = link.href.toLowerCase();
  const text = link.text.toLowerCase();
  if (HREF_KEYWORDS[feature].some((keyword) => href.includes(keyword))) return true;
  return TEXT_KEYWORDS[feature].some((keyword) => text === keyword || text.includes(keyword));
}

/** True when a URL carries a fragment route (an SPA client-side route). */
function isHashRoute(url: string): boolean {
  try {
    return new URL(url).hash.length > 1;
  } catch {
    return false;
  }
}

/**
 * Returns the first locator in `candidates` that is present AND visible,
 * re-checking until something mounts or the timeout expires.
 *
 * This is the single place that tolerates client-side rendering: callers get
 * either a real locator or a definitive null, without each spec re-inventing
 * its own wait.
 */
async function firstVisible(
  page: Page,
  candidates: Locator[],
  timeoutMs = FORM_MOUNT_TIMEOUT_MS,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const candidate of candidates) {
      if ((await candidate.count().catch(() => 0)) > 0) {
        const first = candidate.first();
        if (await first.isVisible().catch(() => false)) return first;
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(FORM_POLL_INTERVAL_MS);
  }
}

/**
 * Waits for any form-like control to mount on the current page.
 *
 * Used to distinguish "this page genuinely has no form" from "the router has
 * not rendered it yet" — the difference between a truthful skip and a false
 * failure. Returns true when something form-like appeared.
 */
export async function waitForFormReady(
  page: Page,
  timeoutMs = FORM_MOUNT_TIMEOUT_MS,
): Promise<boolean> {
  const control = await firstVisible(
    page,
    [
      page.locator('input[type="password"]'),
      page.locator('form input'),
      page.locator('input:not([type="hidden"])'),
      page.locator('textarea'),
    ],
    timeoutMs,
  );
  return control !== null;
}

/**
 * Finds the URL for a feature: explicit config hint first, then homepage links,
 * then conventional paths (including SPA hash routes) confirmed by a real visit.
 */
export async function findFeatureUrl(
  page: Page,
  config: SiteConfig,
  feature: Feature,
): Promise<string | null> {
  const hint = resolveHint(config, config.paths[feature] ?? '');
  if (hint) return hint;

  const links = await collectLinks(page);
  const match = links.find((link) => matches(link, feature));
  if (match) return match.href;

  for (const candidate of conventionalPaths(feature)) {
    const url = new URL(candidate, `${config.baseUrl}/`).toString();

    // A fragment never reaches the server, so an HTTP probe returns the same
    // shell for every hash and proves nothing. Visit the route instead and let
    // the router decide, treating a mounted form as evidence the route exists.
    if (isHashRoute(url)) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (await waitForFormReady(page, 4000)) return url;
      } catch {
        // Route did not resolve — keep probing the remaining conventions.
      }
      continue;
    }

    try {
      const response = await page.request.get(url, { timeout: 15000, maxRedirects: 5 });
      if (response.status() >= 200 && response.status() < 400) {
        return url;
      }
    } catch {
      // Unreachable candidate — keep probing the remaining conventions.
    }
  }
  return null;
}

function conventionalPaths(feature: Feature): string[] {
  switch (feature) {
    case 'login':
      return [
        '/login',
        '/signin',
        '/sign-in',
        '/account/login',
        '/users/sign_in',
        '/#login',
        '/#/login',
        '/#signin',
      ];
    case 'signup':
      return [
        '/signup',
        '/register',
        '/sign-up',
        '/account/register',
        '/users/sign_up',
        '/#signup',
        '/#/signup',
        '/#register',
      ];
    case 'forgotPassword':
      return [
        '/forgot-password',
        '/password/reset',
        '/account/forgot',
        '/reset-password',
        '/#forgot-password',
        '/#/forgot-password',
      ];
    case 'profile':
      return ['/profile', '/account', '/dashboard', '/settings', '/me', '/#profile', '/#/profile'];
    case 'search':
      return ['/search', '/#search', '/#/search'];
    case 'logout':
      return ['/logout', '/signout', '/sign-out', '/#logout', '/#/logout'];
    default:
      return [];
  }
}

/**
 * True when the page exposes a password field — the strongest login signal.
 * Waits for a client-side mount before concluding there is none.
 */
export async function hasPasswordField(page: Page, timeoutMs = FORM_MOUNT_TIMEOUT_MS): Promise<boolean> {
  const visible = await firstVisible(page, [page.locator('input[type="password"]')], timeoutMs);
  if (visible) return true;
  // Some forms keep the password field hidden until the identifier is entered;
  // presence in the DOM still counts as a credential form.
  return (await page.locator('input[type="password"]').count()) > 0;
}

/** Locates a plausible search input on the current page. */
export async function findSearchInput(page: Page) {
  return firstVisible(page, [
    page.getByRole('searchbox'),
    page.locator('input[type="search"]'),
    page.locator('input[name*="search" i]'),
    page.locator('input[name="q" i]'),
    page.locator('input[placeholder*="search" i]'),
    page.locator('input[aria-label*="search" i]'),
  ]);
}

/**
 * Finds the username/email field of a credential form. Ordered from most
 * specific to most generic so we never grab a newsletter box by accident.
 */
export async function findIdentityInput(page: Page) {
  return firstVisible(page, [
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[name*="user" i]'),
    page.locator('input[name*="phone" i]'),
    page.locator('input[id*="email" i]'),
    page.locator('input[id*="user" i]'),
    page.locator('input[placeholder*="email" i]'),
    page.locator('input[placeholder*="user" i]'),
    page.locator('input[type="tel"]'),
    page.locator('input[type="text"]'),
  ]);
}

/** Finds the submit control inside or near a form. */
export async function findSubmitControl(page: Page) {
  return firstVisible(page, [
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
    page.getByRole('button', { name: /log ?in|sign ?in|submit|continue|register|sign ?up|send|reset/i }),
    page.locator('form button'),
  ]);
}

/** Heuristic: does the page look like an authenticated session? */
export async function looksLoggedIn(page: Page): Promise<boolean> {
  // Short timeout on purpose: "no password field" is the expected post-login
  // state, so this must not block for the full mount budget on every call.
  if (await hasPasswordField(page, PRESENCE_CHECK_TIMEOUT_MS)) return false;

  const logoutSignals = page.getByRole('link', { name: /log ?out|sign ?out/i });
  if ((await logoutSignals.count()) > 0) return true;

  const logoutButtons = page.getByRole('button', { name: /log ?out|sign ?out/i });
  if ((await logoutButtons.count()) > 0) return true;

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (/invalid|incorrect|failed|try again|wrong password/.test(body)) return false;

  const cookies = await page.context().cookies();
  return cookies.some((cookie) => /session|auth|token|sid/i.test(cookie.name) && cookie.value.length > 8);
}
