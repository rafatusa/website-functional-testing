# website-functional-testing — working notes

## What this is
Reusable Playwright (TypeScript, Node 22) functional-testing harness for ANY
website, driven by `config.yaml`. Runs entirely on GitHub-hosted runners.
**No cloud infrastructure is provisioned** — no Terraform, no `infra/`.

## Key decisions
- **Backbone mapping.** The platform mandates provision→configure→verify. With
  no infra to build, these map to: provision = prepare env (Node, deps,
  browsers); configure = launch browsers + execute suite; verify = reports +
  artifact upload. A `lint` stage runs first (config validation + typecheck) so
  errors surface before browser downloads.
- **Exit-code deferral (important).** `continue-on-error` is forbidden by the
  spec, but a failing suite must NOT skip artifact upload. So
  `scripts/run-tests.ts` writes Playwright's exit code to `reports/status.json`
  and exits 0; `scripts/summary.ts` (verify stage, after uploads) reads it and
  exits 1. Red run + full evidence. Do not "simplify" this away.
- **Capability discovery over hardcoded selectors.** `src/discovery.ts` finds
  features by href/text keywords, then conventional paths probed with a real
  request. Missing feature => `test.skip()` with a reason, never a failure.
  `config.paths.*` hints override discovery.
- **Browsers:** chromium (desktop 1440x900) + webkit (iPhone 13) projects.
  `workers: 1` — parallel browsers against a stranger's site is rude and flaky.
- **Evidence policy:** screenshot `only-on-failure`, video/trace
  `retain-on-failure` — keeps artifacts small while guaranteeing evidence.
- **Secrets override file config:** SITE_BASE_URL / SITE_USERNAME /
  SITE_PASSWORD beat `config.yaml`, so credentials need not be committed.

## Gotchas discovered
- `npm ci` requires package-lock.json — test_project generates it; never delete.
- Playwright 1.47.2 pinned exactly; `npx playwright install --with-deps` must
  run in every job that launches browsers (fresh runner per job, nothing
  survives job boundaries).
- Each stage re-runs `npm ci` + browser install for the same reason.
- `tsconfig` has `noUnusedLocals`/`noUnusedParameters` on — the typecheck stage
  will catch stray imports. Keep specs clean.
- Broken-link sweep retries HEAD with GET on 405/501; some servers reject HEAD.

## Status
- Meta, architecture, pipeline, plan: approved.
- Generation: complete.
- Next: validate_project → test_project → push → secrets → deploy.
