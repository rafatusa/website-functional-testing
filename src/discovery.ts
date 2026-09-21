import type { Page } from '@playwright/test';
import type { SiteConfig } from './config.js';
import { resolveHint } from './config.js';

export type Feature = 'login' | 'signup' | 'forgotPassword' | 'profile' | 'search' | 'logout';

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

/**
 * Finds the URL for a feature: explicit config hint first, then homepage links,
 * then a small set of conventional paths probed with a real request.
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
      return ['/login', '/signin', '/sign-in', '/account/login', '/users/sign_in'];
    case 'signup':
      return ['/signup', '/register', '/sign-up', '/account/register', '/users/sign_up'];
    case 'forgotPassword':
      return ['/forgot-password', '/password/reset', '/account/forgot', '/reset-password'];
    case 'profile':
      return ['/profile', '/account', '/dashboard', '/settings', '/me'];
    case 'search':
      return ['/search'];
    case 'logout':
      return ['/logout', '/signout', '/sign-out'];
    default:
      return [];
  }
}

/** True when the page exposes a password field — the strongest login signal. */
export async function hasPasswordField(page: Page): Promise<boolean> {
  return (await page.locator('input[type="password"]').count()) > 0;
}

/** Locates a plausible search input on the current page. */
export async function findSearchInput(page: Page) {
  const candidates = [
    page.getByRole('searchbox'),
    page.locator('input[type="search"]'),
    page.locator('input[name*="search" i]'),
    page.locator('input[name="q" i]'),
    page.locator('input[placeholder*="search" i]'),
    page.locator('input[aria-label*="search" i]'),
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      const first = candidate.first();
      if (await first.isVisible().catch(() => false)) return first;
    }
  }
  return null;
}

/**
 * Finds the username/email field of a credential form. Ordered from most
 * specific to most generic so we never grab a newsletter box by accident.
 */
export async function findIdentityInput(page: Page) {
  const candidates = [
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[name*="user" i]'),
    page.locator('input[id*="email" i]'),
    page.locator('input[id*="user" i]'),
    page.locator('input[type="text"]'),
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      const first = candidate.first();
      if (await first.isVisible().catch(() => false)) return first;
    }
  }
  return null;
}

/** Finds the submit control inside or near a form. */
export async function findSubmitControl(page: Page) {
  const candidates = [
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
    page.getByRole('button', { name: /log ?in|sign ?in|submit|continue|register|sign ?up|send|reset/i }),
    page.locator('form button'),
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      const first = candidate.first();
      if (await first.isVisible().catch(() => false)) return first;
    }
  }
  return null;
}

/** Heuristic: does the page look like an authenticated session? */
export async function looksLoggedIn(page: Page): Promise<boolean> {
  if (await hasPasswordField(page)) return false;

  const logoutSignals = page.getByRole('link', { name: /log ?out|sign ?out/i });
  if ((await logoutSignals.count()) > 0) return true;

  const logoutButtons = page.getByRole('button', { name: /log ?out|sign ?out/i });
  if ((await logoutButtons.count()) > 0) return true;

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (/invalid|incorrect|failed|try again|wrong password/.test(body)) return false;

  const cookies = await page.context().cookies();
  return cookies.some((cookie) => /session|auth|token|sid/i.test(cookie.name) && cookie.value.length > 8);
}
