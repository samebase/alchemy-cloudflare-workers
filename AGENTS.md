# AGENTS.md

`@samebase/alchemy-cloudflare-workers-builds` is a community Alchemy v2 provider for Cloudflare
Workers that Workers Builds deploys. It is pinned to `alchemy@2.0.0-beta.80` and Effect 4.

## Ownership rule

- Wrangler owns the version. This package owns the Worker shell, the Workers Builds link, the
  build variables, and the Worker secrets.
- Never write the Worker's version, bindings, vars, assets, routes, or code. The Wrangler file in
  the user's repository is the only source of truth for them.

## Commands

- Vite+ (`vp`) owns format, lint, test, and build.
- `pnpm run check`: format check, lint, typecheck, and unit tests. Run it before each commit.
- `pnpm run build`: write `lib/` with `vp pack`. publint and attw then check the package.
- The pre-commit hook runs `vp staged`. The `prepare` script installs the hook.

## Tests

- Unit tests read recorded real Cloudflare and GitHub payloads in `test/fixtures/`.
- Make a negative case from a changed recorded payload. Do not write a fixture from scratch.
- Replace a fixture from the API schema with a recording when a live run records it.
- Do not commit a token, a secret value, or other credentials.
- Live tests make real API calls. They run only with `ALCHEMY_WORKERS_BUILDS_LIVE=1` (`test:live`).

## Automation and docs

- Write automation in TypeScript under `scripts/`. Node 24 from `.node-version` runs it.
- Automation must work on macOS, Linux, and Windows without Bash or PowerShell.
- Do not add authored `.js`, `.mjs`, or `.cjs` files.
- Write docs in ASD-STE100 Simplified Technical English. Do not use the em dash character.

## Releases

- To release, change `version` in `package.json` and add a `CHANGELOG.md` entry in a pull request.
- After the merge, `.github/workflows/release.yml` publishes that version from `main` to npm.
- Do not change `version` in other pull requests.
