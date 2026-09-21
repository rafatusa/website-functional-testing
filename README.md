# Website Functional Testing

A reusable Playwright test suite that audits **any** website from GitHub Actions.
You supply a URL and (optionally) credentials — the workflow discovers what the
site actually has, tests it, and publishes a professional report with
screenshots, videos and traces for every failure.

No cloud infrastructure is provisioned. Everything runs on a GitHub-hosted
`ubuntu-latest` runner.

## What it tests

| Area | Checks |
| --- | --- |
| Availability | HTTP status, page title, visible content, load time against a budget |
| Validation | JavaScript console errors, failed HTTP responses, broken links, broken images |
| Navigation | Navigation regions, menu links, buttons enabled/actionable, anchor destinations |
| Authentication | Login form present, valid login succeeds, invalid login rejected, logout ends session |
| Account flows | Sign up, forgot password, profile page, protected pages reject anonymous visitors |
| Session | Session does not leak into a fresh browser context after idle time |
| Forms | Required-field enforcement, native email validation |
| Search | Search input discovery and result navigation |
| Responsive | Desktop (1440), tablet (820) and mobile (390) viewports, horizontal overflow |

Every check is **capability-aware**: if a site has no signup page, no search box
or no login form, the relevant tests are reported as **skipped with a reason**
rather than failed. Browsers cover desktop Chromium and mobile WebKit.

## Architecture

See [`.udap/architecture.d2`](.udap/architecture.d2) for the source of truth.
The flow is: config + secrets → GitHub Actions runner → Playwright browsers →
target website → reports → GitHub artifacts.

## Configuration

Edit [`config.yaml`](config.yaml) — normally the only file you touch.

```yaml
baseUrl: https://zavora360.royalbengal.ai/

# Prefer the SITE_USERNAME / SITE_PASSWORD secrets over committing these.
credentials:
  username: ""
  password: ""

tests:
  login: true
  signup: true
  forgotPassword: true
  logout: true
  search: true
```

| Key | Meaning |
| --- | --- |
| `baseUrl` | The site under test. Required. |
| `credentials.username` / `.password` | Optional. Auth tests skip when absent. |
| `tests.*` | Per-area on/off switches. All default to `true`. |
| `paths.*` | Optional explicit URLs (e.g. `paths.login: /account/signin`). Empty means auto-discover. |
| `options.pageLoadBudgetMs` | Load-time budget for the homepage. Default `10000`. |
| `options.maxLinksToCheck` | Links sampled per page in the broken-link sweep. Default `25`. |
| `options.failOnConsoleErrors` | Treat console errors as failures. Default `false` (reported as annotations). |
| `options.sessionIdleSeconds` | Idle time simulated before the session check. Default `5`. |
| `options.ignoreHosts` | Third-party hosts excluded from link/image sweeps. |

### Repository secrets (override `config.yaml`)

Set these so credentials never need to be committed. All are optional.

| Secret | Purpose |
| --- | --- |
| `SITE_BASE_URL` | Overrides `baseUrl` — test a different site without editing the file. |
| `SITE_USERNAME` | Overrides `credentials.username`. |
| `SITE_PASSWORD` | Overrides `credentials.password`. |

Leave the credential secrets unset to audit a site anonymously — the
authentication tests then skip with a recorded reason instead of failing.

Secrets are referenced only as `${{ secrets.NAME }}` in the pipeline spec; no
value is ever stored in this repository.

## Running it

**In CI** — run the project's Deploy action. The workflow is dispatch-only, so
it runs when you ask it to, against whatever `config.yaml` and secrets say.

**Locally:**

```bash
npm ci
npx playwright install --with-deps chromium webkit
npm run validate:config     # check config.yaml before spending browser time
npm run test:local          # run the suite, propagating the real exit code
npm run report:summary      # build reports/summary.md from the last run
npm run report:open         # open the HTML report
```

Point it at a different site for one run:

```bash
SITE_BASE_URL=https://your-site.example npm run test:local
```

## Pipeline stages

Defined in [`.udap/pipeline.yaml`](.udap/pipeline.yaml); the workflow file is
rendered from it — edit the spec, never `.github/workflows/deploy.yml`.

| Stage | What it does |
| --- | --- |
| `lint` | Node 22, `npm ci`, validate `config.yaml`, TypeScript type check |
| `provision` | Node 22, dependencies, `playwright install --with-deps chromium webkit`, report the prepared environment |
| `configure` | Launch browsers, execute the functional suite, capture screenshots/video/traces on failure, generate the HTML + JUnit + summary reports, and upload all four artifacts |
| `verify` | Download the recorded verdict and fail the run if any test failed |

### How a failing site still uploads its evidence

The platform pipeline spec forbids `continue-on-error`, so a non-zero exit from
the test command would skip the reporting and upload steps that follow it —
destroying exactly the evidence a failure needs. Instead:

1. `scripts/run-tests.ts` runs Playwright, records its exit code into
   `reports/status.json`, and exits `0`.
2. Reporting and artifact upload run next **in the same job** — GitHub jobs each
   get a fresh runner, so reports must be produced and uploaded where they were
   generated. The verdict travels inside the `execution-summary` artifact.
3. `scripts/assert-verdict.ts` runs in the `verify` job, downloads that
   artifact, and exits non-zero if the recorded code was non-zero.

A broken site therefore produces a red run *and* a complete set of screenshots,
videos and traces.

## Artifacts

Downloadable from the workflow run summary, retained 30 days:

| Artifact | Contents |
| --- | --- |
| `playwright-html-report` | Interactive HTML report — open `index.html` |
| `junit-xml-report` | `junit.xml` for CI dashboards and test reporting tools |
| `execution-summary` | `summary.md` (pass/fail/skip statistics, failures, skip reasons) and `status.json` |
| `failure-evidence` | Screenshots, videos and `trace.zip` per failed test |

The summary is also printed to the workflow's job summary page, so pass/fail
statistics are visible without downloading anything.

View a trace with `npx playwright show-trace path/to/trace.zip`.

## Project layout

```
config.yaml                  the only file most users edit
playwright.config.ts         browsers, reporters, failure-evidence policy
src/config.ts                typed config loader + env overrides
src/discovery.ts             capability discovery (find login/search/profile…)
src/collectors.ts            console errors, broken links/images, load timing
src/fixtures.ts              shared test fixtures
tests/                       the functional specs
scripts/                     config validation, env report, runner, summary, verdict gate
.udap/                       architecture, pipeline spec, working notes
```

## Interpreting results

- **FAIL** — a real defect on the site under test. Open the HTML report, then
  the trace for a step-by-step replay.
- **SKIP** — the feature was not found or is disabled in `config.yaml`. The
  summary lists the reason for each skip; add a `paths.*` hint if a feature
  exists but discovery missed it.
- **FLAKY** — passed on retry. Usually a slow third-party resource; check the
  page load annotation.
