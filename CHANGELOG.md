# Changelog

## 0.5.0

`WorkersBuilds.Repository` is never replaced, and drift detection sees the settings that the
resources own.

- `WorkersBuilds.Repository`: a renamed repository no longer deletes the Builds configuration.
  Before, a new name without the GitHub ids on both sides was a replacement. Alchemy creates
  before it deletes, so the deploy updated the configuration of the same Worker and then deleted
  it. The deploy reported success, but the Worker had no automatic builds.
- `WorkersBuilds.Repository`: the diff never replaces the resource. The plan reads the GitHub ids
  of the repository (once per deploy) and compares the repository id with the one that the
  configuration builds from. The same id is an update. Another repository id is also an update:
  the deploy deletes the triggers and the configuration, then creates the configuration for the
  new repository. Another `worker` creates the new configuration, then deletes the old one.
- `WorkersBuilds.Repository`: only an explicit `repository` prop moves the builds to another
  repository. When the repository of the run differs from the configuration, the plan shows an
  update, and the deploy fails with `WorkersBuildsError`, as before.
- `WorkersBuilds.Repository`: new outputs `repository`, `production`, and `preview`. They hold
  the repository with its GitHub ids, the production branch, and the build settings, with the
  variable names but no values. `alchemy drift` now sees a changed build command, path filter,
  root directory, build token, or a removed variable, and the repair restores it. A changed
  variable value is not drift: Cloudflare never returns secret values, and attributes show in
  plans.
- `WorkersBuilds.Worker`: the outputs hold each setting that the props declare, as Cloudflare
  reports it. `alchemy drift` now sees a change of a declared setting. Settings that the props
  leave out are still not compared, because the Wrangler file can own them.
- `WorkersBuilds.Repository` reads the configuration back after its PATCH, and
  `WorkersBuilds.Worker` reads the Worker back after its PATCH. Each update makes one more GET.

Upgrade:

- The first deploy after the upgrade plans an update of each `WorkersBuilds.Repository`, and of
  each `WorkersBuilds.Worker` that declares a setting. The update saves the new outputs. It
  writes the same settings again.
- A plan now reads GitHub for each `WorkersBuilds.Repository` without `ownerId`, `repositoryId`,
  and `branch`. For a private repository, set `GITHUB_TOKEN` where you run `alchemy plan`.

## 0.4.0

Breaking change: destroy deletes a `WorkersBuilds.Worker`, as it deletes Alchemy's own
`Cloudflare.Worker`. To keep a Worker on destroy, use Alchemy's removal policy.

- `WorkersBuilds.Worker`: the `delete` prop is removed. Destroy and replacement delete the Worker
  with all of its versions and preview URLs through
  `DELETE /accounts/{account_id}/workers/workers/{worker_id}`. A Worker that is already gone is not
  an error. Before, destroy only removed the Worker from state unless `delete` was `true`.
- The resource keeps Alchemy's default removal policy, `destroy`. Alchemy retains by default only
  resources that it cannot make again, such as `Cloudflare.Zone`. The Wrangler file and the next
  build make a Worker again.
- State from 0.3 holds `delete` in the saved props. The first deploy after the upgrade plans an
  update of the Worker. That update sends no PATCH.

Migration:

- `delete: true`: remove the prop. Destroy deletes the Worker, as it did.
- `delete: false`, or no `delete` (the old default): remove the prop. When the Worker must stay after
  destroy, wrap the call:
  `yield* WorkersBuilds.Worker("Worker", { name }).pipe(Alchemy.RemovalPolicy.retain())`. This also
  applies to an adopted Worker. The policy is not a prop, so the plan shows no change. Deploy once
  after you add it. A destroy before that deploy deletes the Worker.

## 0.3.1

Renamed to `@samebase/alchemy-cloudflare-workers-builds`. The old name, `@samebase/alchemy-cloudflare-workers`,
is deprecated on npm and stays at 0.3.0.

An account without a build token no longer needs a manual step in the Cloudflare dashboard.

- `WorkersBuilds.Repository`: without `buildToken`, on an account without a build token, the
  provider registers the stack's API token as a build token named `alchemy-<stack name>`. It reads
  the token id from `GET /user/tokens/verify` and calls `POST /accounts/{account_id}/builds/tokens`.
  Before, the deploy failed and told you to connect a Worker to Git once in the dashboard. The order
  is `buildToken`, then the account's first build token, then the registration.
- Destroy keeps the registered build token: build tokens belong to the account, and other
  configurations can use them.
- Workers Builds accepts only API tokens. With the OAuth login or a global API key, the provider
  cannot register a build token, and the deploy fails with `WorkersBuildsError`, as before.
- Docs: Workers Builds deploys with the registered token, so the token needs the permissions of the
  deploy: Workers Scripts: Edit, and R2, KV, and D1 edit when the Wrangler file binds them.
- Unit tests prove the requests and the order on payloads from Cloudflare's API schema. No live run
  has registered a build token yet.

## 0.3.0

A run file can now leave out the Worker name and the repository, so it works unchanged in each fork
of the repository.

- `WorkersBuilds.Repository`: `repository` is optional. Without it, the provider uses the
  repository of the run: `GITHUB_REPOSITORY` in GitHub Actions (Alchemy's `GitHubEnv`), else the
  `origin` remote of the current directory. When neither gives a repository, the deploy fails with
  one `WorkersBuildsError`.
- `WorkersBuilds.Repository`: `repository.branch` is optional. Without it, the production branch is
  the default branch from the same GitHub call that reads the ids.
- `WorkersBuilds.Repository`: with `repositoryId` in the old and the new props, the diff compares
  only the ids. A renamed repository is an update, not a replacement.
- `WorkersBuilds.Repository`: each deploy that reconciles the configuration checks that it builds
  from the repository, by id, and reads the repository from GitHub unless the props hold `ownerId`,
  `repositoryId`, and `branch`. Before, only adoption checked, and only create and adoption read
  GitHub.
- `WorkersBuilds.currentRepository`: the same resolver for the run file. It yields
  `{ owner, name, defaultBranch, ownerId, repositoryId }`. A run file pipes it through
  `Effect.orDie`, because a run file can fail only with `ConfigError`.
- `WorkersBuilds.Worker`: `name` is optional. Without it, the provider makes the name with Alchemy's
  `createPhysicalName` (stack, logical id, stage, 8 characters, at most 54) on create and keeps it in
  state. Only an explicit name that differs replaces the Worker. `WorkersBuilds.Worker(id)` without
  props works.
- Docs: on Wrangler 3 and later, Workers Builds deploys to the connected Worker whatever `name` the
  Wrangler file has, so the names need not match.

## 0.2.0

- `WorkersBuilds.Secret`: write one Worker secret through the Workers script API, for a Worker
  that Workers Builds deploys. Wrangler keeps secrets on deploy, so the secret stays across builds.
  A different Worker or name replaces the secret, and a new value updates it. Read checks only the
  name, because Cloudflare never returns a value. An existing secret is adopted only with
  `--adopt`, and the first deploy after that writes the value. Destroy deletes the secret.
- Unit tests prove the requests and the error handling on payloads from Cloudflare's API schema.
  The live test (`secret.live.test.ts`) has not run yet.

## 0.1.0

First release, pinned to `alchemy@2.0.0-beta.80` and Effect 4. Proven on a Samebase-managed app:
the stack adopted the existing Worker and its Workers Builds configuration, created new Convex deploy
keys, wrote them as build secrets, and the next preview and production builds succeeded with them.

- `WorkersBuilds.Worker`: create a Worker without code, edit only the settings that the props name,
  adopt by name with `--adopt`, replace on a new name, delete only with `delete: true`.
- `WorkersBuilds.Repository`: link a GitHub repository to a Worker through Workers Builds, set the
  build and deploy commands, migrate legacy branch triggers to Worker Previews, write build
  variables (`Redacted` values as secrets), and remove the triggers and the configuration on
  destroy.
- One clear `WorkersBuildsPermissionError` when the credentials have no Workers Builds access, such
  as the Alchemy OAuth login.
