import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export interface TestToggles {
  homepage: boolean;
  navigation: boolean;
  login: boolean;
  logout: boolean;
  signup: boolean;
  forgotPassword: boolean;
  profile: boolean;
  search: boolean;
  forms: boolean;
  links: boolean;
  protectedPages: boolean;
  sessionTimeout: boolean;
  responsive: boolean;
}

export interface PathHints {
  login: string;
  signup: string;
  forgotPassword: string;
  profile: string;
  search: string;
  logout: string;
  protected: string;
}

export interface TestOptions {
  pageLoadBudgetMs: number;
  maxLinksToCheck: number;
  failOnConsoleErrors: boolean;
  sessionIdleSeconds: number;
  ignoreHosts: string[];
}

export interface Credentials {
  username: string;
  password: string;
}

export interface SiteConfig {
  baseUrl: string;
  credentials: Credentials;
  hasCredentials: boolean;
  tests: TestToggles;
  paths: PathHints;
  options: TestOptions;
}

const DEFAULT_TOGGLES: TestToggles = {
  homepage: true,
  navigation: true,
  login: true,
  logout: true,
  signup: true,
  forgotPassword: true,
  profile: true,
  search: true,
  forms: true,
  links: true,
  protectedPages: true,
  sessionTimeout: true,
  responsive: true,
};

const DEFAULT_PATHS: PathHints = {
  login: '',
  signup: '',
  forgotPassword: '',
  profile: '',
  search: '',
  logout: '',
  protected: '',
};

const DEFAULT_OPTIONS: TestOptions = {
  pageLoadBudgetMs: 10000,
  maxLinksToCheck: 25,
  failOnConsoleErrors: false,
  sessionIdleSeconds: 5,
  ignoreHosts: [],
};

export class ConfigError extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(normalized)) return true;
    if (['false', 'no', '0', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry) => entry.length > 0);
}

export function configPath(): string {
  return resolve(process.env.CONFIG_FILE ?? 'config.yaml');
}

/**
 * Loads config.yaml and applies environment overrides.
 *
 * Environment wins over the file so credentials can live in repository secrets:
 *   SITE_BASE_URL, SITE_USERNAME, SITE_PASSWORD
 */
export function loadConfig(): SiteConfig {
  const file = configPath();
  if (!existsSync(file)) {
    throw new ConfigError(`Configuration file not found: ${file}`);
  }

  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`config.yaml is not valid YAML: ${(error as Error).message}`);
  }

  const root = asRecord(raw);
  const credentialsBlock = asRecord(root.credentials);
  const togglesBlock = asRecord(root.tests);
  const pathsBlock = asRecord(root.paths);
  const optionsBlock = asRecord(root.options);

  const baseUrl = asString(process.env.SITE_BASE_URL) || asString(root.baseUrl);
  if (!baseUrl) {
    throw new ConfigError(
      'baseUrl is required. Set it in config.yaml or via the SITE_BASE_URL repository secret.',
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new ConfigError(`baseUrl is not a valid absolute URL: "${baseUrl}"`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new ConfigError(`baseUrl must use http or https, got "${parsedUrl.protocol}"`);
  }

  const username = asString(process.env.SITE_USERNAME) || asString(credentialsBlock.username);
  const password = process.env.SITE_PASSWORD ?? asString(credentialsBlock.password);

  const tests: TestToggles = { ...DEFAULT_TOGGLES };
  for (const key of Object.keys(DEFAULT_TOGGLES) as (keyof TestToggles)[]) {
    tests[key] = asBool(togglesBlock[key], DEFAULT_TOGGLES[key]);
  }

  const paths: PathHints = { ...DEFAULT_PATHS };
  for (const key of Object.keys(DEFAULT_PATHS) as (keyof PathHints)[]) {
    paths[key] = asString(pathsBlock[key]);
  }

  const options: TestOptions = {
    pageLoadBudgetMs: asNumber(optionsBlock.pageLoadBudgetMs, DEFAULT_OPTIONS.pageLoadBudgetMs),
    maxLinksToCheck: asNumber(optionsBlock.maxLinksToCheck, DEFAULT_OPTIONS.maxLinksToCheck),
    failOnConsoleErrors: asBool(
      optionsBlock.failOnConsoleErrors,
      DEFAULT_OPTIONS.failOnConsoleErrors,
    ),
    sessionIdleSeconds: asNumber(optionsBlock.sessionIdleSeconds, DEFAULT_OPTIONS.sessionIdleSeconds),
    ignoreHosts: asStringArray(optionsBlock.ignoreHosts),
  };

  const trimmedPassword = typeof password === 'string' ? password.trim() : '';

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    credentials: { username, password: trimmedPassword },
    hasCredentials: username.length > 0 && trimmedPassword.length > 0,
    tests,
    paths,
    options,
  };
}

/** Resolves a path hint against the base URL. Empty hints return null. */
export function resolveHint(config: SiteConfig, hint: string): string | null {
  if (!hint) return null;
  try {
    return new URL(hint, `${config.baseUrl}/`).toString();
  } catch {
    return null;
  }
}
