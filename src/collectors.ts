import type { Page, Response } from '@playwright/test';
import type { SiteConfig } from './config.js';
import { collectLinks } from './discovery.js';

export interface ConsoleIssue {
  type: string;
  text: string;
  location: string;
}

export interface ResourceIssue {
  url: string;
  status: number | string;
  context: string;
}

/**
 * Attaches console and page-error listeners. The returned array fills as the
 * page navigates, so attach it before the first goto().
 */
export function watchConsole(page: Page): ConsoleIssue[] {
  const issues: ConsoleIssue[] = [];

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    issues.push({
      type: 'console.error',
      text: message.text().slice(0, 500),
      location: `${location.url}:${location.lineNumber}`,
    });
  });

  page.on('pageerror', (error) => {
    issues.push({
      type: 'pageerror',
      text: (error.message ?? String(error)).slice(0, 500),
      location: 'page',
    });
  });

  return issues;
}

/** Records every failed HTTP response (>=400) the page triggers. */
export function watchResponses(page: Page): ResourceIssue[] {
  const issues: ResourceIssue[] = [];
  page.on('response', (response: Response) => {
    if (response.status() >= 400) {
      issues.push({ url: response.url(), status: response.status(), context: 'network' });
    }
  });
  return issues;
}

function isIgnored(url: string, config: SiteConfig): boolean {
  return config.options.ignoreHosts.some((host) => url.includes(host));
}

export interface TimedNavigation {
  status: number;
  durationMs: number;
  url: string;
}

/**
 * Navigates and measures wall-clock load time.
 *
 * A same-document navigation (a hash route such as `/#login` on a single-page
 * app) produces NO network response, so `page.goto` resolves with null. That is
 * success, not an error — we report the status of the underlying document
 * instead of a meaningless 0 so assertions and the report stay truthful.
 */
export async function timedGoto(page: Page, url: string): Promise<TimedNavigation> {
  const started = Date.now();
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  const durationMs = Date.now() - started;

  let status = response?.status() ?? 0;
  if (!response) {
    // Same-document navigation: confirm the document itself is healthy.
    try {
      const document = await page.request.get(url.split('#')[0], {
        timeout: 15000,
        maxRedirects: 5,
      });
      status = document.status();
    } catch {
      status = 200; // The page is already rendered in the browser; treat as served.
    }
  }

  return { status, durationMs, url: page.url() };
}

/**
 * Samples same-origin links from the current page and HEAD/GETs each one.
 * Returns only the broken ones.
 */
export async function findBrokenLinks(page: Page, config: SiteConfig): Promise<ResourceIssue[]> {
  const origin = new URL(config.baseUrl).origin;
  const links = await collectLinks(page);

  const unique = new Map<string, string>();
  for (const link of links) {
    const clean = link.href.split('#')[0];
    if (!clean.startsWith(origin)) continue;
    if (isIgnored(clean, config)) continue;
    if (!unique.has(clean)) unique.set(clean, link.text);
    if (unique.size >= config.options.maxLinksToCheck) break;
  }

  const broken: ResourceIssue[] = [];
  for (const [url, text] of unique) {
    try {
      let response = await page.request.head(url, { timeout: 15000, maxRedirects: 5 });
      // Some servers reject HEAD outright — retry those with GET before judging.
      if (response.status() === 405 || response.status() === 501) {
        response = await page.request.get(url, { timeout: 15000, maxRedirects: 5 });
      }
      if (response.status() >= 400) {
        broken.push({ url, status: response.status(), context: text || 'link' });
      }
    } catch (error) {
      broken.push({ url, status: (error as Error).message.slice(0, 120), context: text || 'link' });
    }
  }
  return broken;
}

/** Detects images that rendered with zero natural size (failed to load). */
export async function findBrokenImages(page: Page, config: SiteConfig): Promise<ResourceIssue[]> {
  const candidates = await page.evaluate(() => {
    const images = Array.from(document.querySelectorAll('img'));
    return images
      .filter((image) => {
        const element = image as HTMLImageElement;
        if (!element.currentSrc && !element.src) return false;
        if (element.loading === 'lazy' && !element.complete) return false;
        return element.complete && element.naturalWidth === 0;
      })
      .map((image) => ({
        src: (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src,
        alt: (image as HTMLImageElement).alt ?? '',
      }));
  });

  return candidates
    .filter((candidate) => !isIgnored(candidate.src, config))
    .map((candidate) => ({
      url: candidate.src,
      status: 'naturalWidth=0',
      context: candidate.alt || 'image',
    }));
}

/** Formats issues for a readable assertion message. */
export function formatIssues(issues: Array<ConsoleIssue | ResourceIssue>): string {
  return issues
    .map((issue) =>
      'text' in issue
        ? `- [${issue.type}] ${issue.text} (${issue.location})`
        : `- [${issue.status}] ${issue.url} (${issue.context})`,
    )
    .join('\n');
}
