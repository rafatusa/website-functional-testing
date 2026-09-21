import type { Page, Locator } from '@playwright/test';
import type { SiteConfig } from './config.js';
import { resolveHint } from './config.js';

export type Feature = 'login' | 'signup' | 'forgotPassword' | 'profile' | 'search' | 'logout';

/**
 * How long to wait for a client-side router to mount a form after navigation.
 *
 * Single-page apps render the real form only after the router reacts, so
 * counting inputs immediately after `goto` sees nothing and produces a false
 * "feature absent" verdict. Form lookups wait for a mount before giving up.
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
 * How many matches of a selector to examine before moving on.
 *
 * SPAs frequently ship EVERY panel in one document (login, signup, reset,
 * dashboards) and collapse the inactive ones to 0x0 instead of unmounting
 * them. A selector like input[type="email"] can therefore match several
 * elements where only one is the live field, so we must scan matches rather
 * than trusting the first.
 */
const MAX_MATCHES_PER_SELECTOR = 20;

/**
 * Ancestor chain searched when scoping an action to the panel that owns a
 * field. Ordered outward: the tightest container that holds a submit control
 * wins, so we never climb far enough to swallow a sibling panel's button.
 */
const PANEL_ANCESTOR_XPATHS = [
  'xpath=ancestor::form[1]',
  'xpath=ancestor::*[self::div or self::section or self::fieldset][1]',
  'xpath=ancestor::*[self::div or self::section or self::fieldset][2]',
  'xpath=ancestor::*[self::div or self::section or self::fieldset][3]',
];

/** Accessible-name pattern for controls that submit a credential form. */
const SUBMIT_NAME_PATTERN = /log ?in|sign ?in|submit|continue|register|sign ?up|send|reset/i;

/** Narrower pattern used to prefer the login action over a generic button. */
const LOGIN_NAME_PATTERN = /log ?in|sign ?in|continue|submit/i;

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

/** Selector list for identity (username/email) inputs, most specific first. */
const IDENTITY_SELECTORS = [
  'input[type="email"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[name*="phone" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="user" i]',
  'input[type="tel"]',
  'input[type="text"]',
];

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
 * True when an element is genuinely interactable: visible AND occupying real
 * space. `isVisible()` alone is not enough — a collapsed panel's inputs can
 * report visible while measuring 0x0, and filling one silently does nothing.
 */
async function isUsable(locator: Locator): Promise<boolean> {
  if (!(await locator.isVisible().catch(() => false))) return false;
  const box = await locator.boundingBox().catch(() => null);
  return box !== null && box.width > 0 && box.height > 0;
}

/**
 * Returns the first USABLE element among all matches of the given selectors,
 * re-checking until something mounts or the timeout expires.
 *
 * Scans EVERY match of each selector, not just the first. SPAs that keep all
 * panels in the DOM routinely make the first match a collapsed 0x0 field from
 * an inactive panel (e.g. a hidden signup form preceding the live login form),
 * so testing only `.first()` reports "no field" while the real one sits a few
 * nodes later.
 */
async function firstVisible(
  page: Page,
  candidates: Locator[],
  timeoutMs = FORM_MOUNT_TIMEOUT_MS,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const candidate of candidates) {
      const count = Math.min(
        await candidate.count().catch(() => 0),
        MAX_MATCHES_PER_SELECTOR,
      );
      for (let index = 0; index < count; index += 1) {
        const element = candidate.nth(index);
        if (await isUsable(element)) return element;
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(FORM_POLL_INTERVAL_MS);
  }
}

/** Locators for every identity-input selector, in priority order. */
function identityCandidates(page: Page): Locator[] {
  return IDENTITY_SELECTORS.map((selector) => page.locator(selector));
}

/**
 * Waits for any form-like control to mount on the current page.
 *
 * Distinguishes "this page genuinely has no form" from "the router has not
 * rendered it yet" — the difference between a truthful skip and a false
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
 * Opens a credential panel that is present but not yet interactable.
 *
 * With the all-matches search above, a login form that merely sits behind
 * collapsed siblings is already found directly. This remains as a fallback for
 * genuine modals, where NO credential field has a usable box until a trigger
 * is clicked. Returns true when a credential field is usable afterwards.
 */
export async function activateAuthPanel(page: Page): Promise<boolean> {
  if (await firstVisible(page, identityCandidates(page), PRESENCE_CHECK_TIMEOUT_MS)) return true;

  const triggers = [
    page.getByRole('button', { name: /log ?in|sign ?in/i }),
    page.getByRole('link', { name: /log ?in|sign ?in/i }),
    page.getByRole('tab', { name: /log ?in|sign ?in/i }),
    page.locator('[data-target*="login" i], [data-toggle*="login" i], [href="#login"]'),
  ];

  for (const trigger of triggers) {
    const count = await trigger.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 3); index += 1) {
      const control = trigger.nth(index);
      if (!(await isUsable(control))) continue;
      await control.click({ timeout: 5000 }).catch(() => undefined);
      if (await firstVisible(page, identityCandidates(page), 2000)) return true;
    }
  }
  return false;
}

/**
 * Compact DOM diagnostic for the current page's inputs.
 *
 * Attached to test annotations when discovery fails, so a SKIP carries evidence
 * of WHY. A skip produces no screenshot or trace, which previously made this
 * class of problem invisible in the report.
 */
export async function describeFormState(page: Page): Promise<string> {
  const details = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
    const described = inputs.slice(0, 25).map((node) => {
      const element = node as HTMLInputElement;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return [
        element.tagName.toLowerCase(),
        `type=${element.type ?? '-'}`,
        `id=${element.id || '-'}`,
        `name=${element.name || '-'}`,
        `display=${style.display}`,
        `visibility=${style.visibility}`,
        `size=${Math.round(rect.width)}x${Math.round(rect.height)}`,
      ].join(' ');
    });
    return {
      total: inputs.length,
      forms: document.querySelectorAll('form').length,
      url: window.location.href,
      described,
    };
  });

  return [
    `url=${details.url}`,
    `inputs=${details.total} forms=${details.forms}`,
    ...details.described.map((line) => `  - ${line}`),
  ].join('\n');
}

/**
 * One-line identification of a control, for annotations.
 *
 * A failed submit is otherwise indistinguishable from a rejected credential:
 * recording WHICH button was clicked turns "login did not work" into evidence
 * without needing to open a trace.
 */
export async function describeControl(locator: Locator | null): Promise<string> {
  if (!locator) return 'none';
  return locator
    .evaluate((node) => {
      const element = node as HTMLElement;
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const id = element.id || '-';
      const name = (element as HTMLInputElement).name || '-';
      const type = (element as HTMLInputElement).type || '-';
      return `${element.tagName.toLowerCase()} id=${id} name=${name} type=${type} text="${text}"`;
    })
    .catch(() => 'unreadable');
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

/** Returns the live (usable) password field, or null. */
export async function findPasswordInput(page: Page, timeoutMs = FORM_MOUNT_TIMEOUT_MS) {
  return firstVisible(page, [page.locator('input[type="password"]')], timeoutMs);
}

/**
 * Returns the live (usable) email field, or null.
 *
 * Deliberately not `input[type=email]`.first(): a page that mounts several
 * panels exposes collapsed 0x0 email inputs from inactive forms ahead of the
 * one the user can actually type into.
 */
export async function findEmailInput(page: Page, timeoutMs = FORM_MOUNT_TIMEOUT_MS) {
  return firstVisible(
    page,
    [page.locator('input[type="email"]'), page.locator('input[name*="email" i]')],
    timeoutMs,
  );
}

/**
 * True when the page exposes a password field — the strongest login signal.
 * Waits for a client-side mount before concluding there is none.
 */
export async function hasPasswordField(page: Page, timeoutMs = FORM_MOUNT_TIMEOUT_MS): Promise<boolean> {
  if (await findPasswordInput(page, timeoutMs)) return true;
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
 *
 * Falls back to searching inside the container of the LIVE password field, so
 * the identity input is taken from the same panel the user would actually type
 * into rather than from a collapsed sibling form.
 */
export async function findIdentityInput(page: Page) {
  const generic = await firstVisible(page, identityCandidates(page));
  if (generic) return generic;

  const password = await findPasswordInput(page, PRESENCE_CHECK_TIMEOUT_MS);
  if (!password) return null;

  const scoped = password.locator(
    'xpath=ancestor::*[self::form or self::div or self::section][1]',
  );
  return firstVisible(
    page,
    [
      scoped.locator('input[type="email"]'),
      scoped.locator('input[type="text"]'),
      scoped.locator('input[type="tel"]'),
      scoped.locator('input:not([type="password"]):not([type="hidden"])'),
    ],
    PRESENCE_CHECK_TIMEOUT_MS,
  );
}

/**
 * Finds the submit control of the panel that OWNS the given field.
 *
 * Visibility alone cannot pick the right button on a multi-panel SPA: a header
 * "Login" trigger or a sibling panel's "Sign Up" button is perfectly visible
 * and will be found first by a page-wide scan, so the credentials get typed
 * into one form while a different form's button is clicked — the submit
 * silently does nothing and the login appears to fail.
 *
 * Containment is the only reliable discriminator, so we climb from the field
 * outward and take the button from the TIGHTEST ancestor that has one,
 * preferring a login-worded control over a generic button.
 */
export async function findSubmitControlNear(page: Page, anchor: Locator | null) {
  if (!anchor) return findSubmitControl(page);

  for (const ancestor of PANEL_ANCESTOR_XPATHS) {
    const container = anchor.locator(ancestor);
    if ((await container.count().catch(() => 0)) === 0) continue;

    const preferred = await firstVisible(
      page,
      [
        container.getByRole('button', { name: LOGIN_NAME_PATTERN }),
        container.locator('button[type="submit"]'),
        container.locator('input[type="submit"]'),
      ],
      PRESENCE_CHECK_TIMEOUT_MS,
    );
    if (preferred) return preferred;

    const anyControl = await firstVisible(
      page,
      [
        container.getByRole('button', { name: SUBMIT_NAME_PATTERN }),
        container.locator('button'),
      ],
      PRESENCE_CHECK_TIMEOUT_MS,
    );
    if (anyControl) return anyControl;
  }

  return null;
}

/**
 * Page-wide submit lookup. Correct for single-form pages; on multi-panel sites
 * prefer findSubmitControlNear, which cannot cross a panel boundary.
 */
export async function findSubmitControl(page: Page) {
  return firstVisible(page, [
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
    page.getByRole('button', { name: SUBMIT_NAME_PATTERN }),
    page.locator('form button'),
  ]);
}

/**
 * Submits a credential form.
 *
 * Clicks the panel-scoped control when one exists; otherwise presses Enter in
 * the password field. The keyboard path is always panel-correct — the browser
 * routes it to the form owning the focused field — so a panel with no
 * recognisable button still submits instead of skipping.
 */
export async function submitCredentialForm(
  page: Page,
  password: Locator,
  submit: Locator | null,
): Promise<void> {
  if (submit) {
    await submit.click({ timeout: 10000 });
    return;
  }
  await password.press('Enter');
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
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
