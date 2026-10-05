# @samebase/alchemy-cloudflare-workers-builds

[Alchemy v2](https://alchemy.run) resources for Cloudflare Workers that
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) deploys from a Git
repository. Use them when the repository's `wrangler.jsonc` defines the Worker and Cloudflare
builds each commit.

The package adds only what the built-in `alchemy/Cloudflare` provider does not have:

- `WorkersBuilds.Worker`: a Worker that exists without code.
- `WorkersBuilds.Repository`: the Workers Builds configuration that links a GitHub repository to
  that Worker.
- `WorkersBuilds.Secret`: a secret of that Worker. Wrangler keeps it on each deploy.

This is a community provider, maintained by [Samebase](https://samebase.com).

Status: 0.5, pinned to `alchemy@2.0.0-beta.80` and Effect 4. Alchemy ships breaking changes
between betas. Upgrade this package and Alchemy together.

## Ownership rule

Wrangler owns the version. This package owns the shell, the link, and the secrets.

- The Wrangler file in the repository is the only source of truth for the code, the bindings
  other than secrets, vars, assets, routes, and compatibility settings. Alchemy never uploads code
  and never writes these.
- Workers Builds runs `npx wrangler deploy` on each push to the production branch and
  `npx wrangler preview` on each other branch.
- This package creates the Worker shell, links the repository, sets the build commands, and writes
  the build variables.
- This package also writes the Worker secrets. Wrangler
  [does not delete secrets](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)
  on deploy, so a secret that this package writes stays across builds. Give each name one owner:
  do not also set a secret name in `vars` of the Wrangler file.

Wrangler also writes some Worker settings on each deploy: `observability`, `logpush`,
`workers_dev`, and `preview_urls`. `WorkersBuilds.Worker` writes a setting after create only when
its props name it. If the Wrangler file names a setting, do not set it on the resource. Then the
two never write different values.

## Install

```sh
pnpm add -D @samebase/alchemy-cloudflare-workers-builds alchemy@2.0.0-beta.80 effect@^4.0.0 @effect/platform-node@^4.0.0
```

## Credentials

The resources use the same Cloudflare credentials and account as `Cloudflare.providers()`.

The Alchemy OAuth login has no Workers Builds scope. With the OAuth login alone, Cloudflare refuses
the calls, and the resources fail with `WorkersBuildsPermissionError`. Use a user-scoped API token
instead:

1. Create a user API token in the Cloudflare dashboard with these permissions:
   - Workers Builds Configuration: Edit
   - Workers Scripts: Edit
   - Account Settings: Read
2. Set `CLOUDFLARE_API_TOKEN` to the token and `CLOUDFLARE_ACCOUNT_ID` to the account id.

Alchemy uses environment credentials only when both variables are set. They then replace the
profile for the whole stack, so also give the token the permissions that the other resources in
the stack need.

When the account has no build token and `WorkersBuilds.Repository` has no `buildToken`, the
provider registers this token as the build token (see [Build token](#workersbuildsrepository)).
Workers Builds then deploys with it, so also give it the permissions of the deploy:

- Workers Scripts: Edit (in the list above)
- Workers R2 Storage: Edit, Workers KV Storage: Edit, and D1: Edit, when the Wrangler file binds
  R2 buckets, KV namespaces, or D1 databases

To register the token, the provider needs no other permission. If you roll or delete the token,
the builds that deploy with it fail.

The Cloudflare Workers and Pages GitHub App must have access to the repository. Install it once from
**Workers & Pages** in the Cloudflare dashboard.

## Example

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkersBuilds from "@samebase/alchemy-cloudflare-workers-builds";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), WorkersBuilds.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Without `name`, Alchemy makes one, such as `myapp-worker-dev-k3m7x2ab`.
    const worker = yield* WorkersBuilds.Worker("Worker");

    // Without `repository`, the repository of this clone or GitHub Actions
    // run, built from its default branch.
    const builds = yield* WorkersBuilds.Repository("Builds", {
      worker: worker.workerId,
      buildCommand: "pnpm install && pnpm run build",
      variables: { CONVEX_DEPLOY_KEY: Config.Redacted("CONVEX_DEPLOY_KEY") },
      previewVariables: { CONVEX_DEPLOY_KEY: Config.Redacted("CONVEX_PREVIEW_DEPLOY_KEY") },
    });

    // A Worker secret: the code reads it as env.API_KEY.
    yield* WorkersBuilds.Secret("ApiKey", {
      worker: worker.name,
      name: "API_KEY",
      value: Config.Redacted("API_KEY"),
    });

    return { url: worker.url, triggerIds: builds.triggerIds };
  }),
);
```

The run file names no Worker, repository, or id, so it works unchanged in each fork of the
repository. Alchemy creates the Worker first, because the configuration and the secret use its
outputs. The Worker has no version until Workers Builds builds the next push to the production
branch.

### Without `repository`

`WorkersBuilds.Repository` then uses the repository of the run, in this order:

1. In GitHub Actions, `GITHUB_REPOSITORY`, through Alchemy's `GitHubEnv` from `alchemy/GitHub`.
2. Else the `origin` remote of the current directory (`git remote get-url origin`), in the form
   `https://github.com/<owner>/<name>` or `git@github.com:<owner>/<name>`, with or without `.git`.

When neither gives a GitHub repository, the plan or the deploy fails with `WorkersBuildsError`.
The provider then reads the GitHub ids and, without `repository.branch`, the default branch from
one call to `GET https://api.github.com/repos/{owner}/{name}`. For a private repository, set
`GITHUB_TOKEN`. In GitHub Actions, pass `GITHUB_TOKEN: ${{ github.token }}` in `env`.

The plan reads the repository of the run. When the configuration builds from another repository,
the plan shows an update, and the deploy fails with `WorkersBuildsError`. The repository of the run
never moves the builds to another repository, because a clone of a fork must not take over the
production builds. To move the builds, pass `repository`.

`WorkersBuilds.currentRepository` is the same resolver, for names in the run file. It yields
`{ owner, name, defaultBranch, ownerId, repositoryId }`. A run file can fail only with
`ConfigError`, so pipe it through `Effect.orDie`:

```ts
Effect.gen(function* () {
  const repository = yield* WorkersBuilds.currentRepository.pipe(Effect.orDie);
  const worker = yield* WorkersBuilds.Worker("Worker", { name: repository.name });
  // ...
});
```

### Without `name`

`WorkersBuilds.Worker` then makes the name with Alchemy's `createPhysicalName`, as other Alchemy
resources do: the stack name, the logical id, the stage, and 8 characters of the resource's
instance id, lowercase and at most 54 characters, such as `myapp-worker-dev-k3m7x2ab`.

- The name is made once, on create, and stays in state. Later deploys use the stored name. A
  replacement, such as another account, makes a new name.
- An explicit `name` that differs from the stored name replaces the Worker. Removing `name` keeps
  the Worker and its name.
- On Wrangler 3 and later, Workers Builds deploys to the connected Worker
  [whatever `name` the Wrangler file has](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/).
- The name is also the `workers.dev` hostname: `https://<name>.<account subdomain>.workers.dev`.
  A production Worker usually wants an explicit name.

### Keep the Worker on destroy

Destroy deletes the Worker with all of its versions and preview URLs. A stack that must keep a
production Worker on destroy wraps the call in Alchemy's removal policy:

```ts
Effect.gen(function* () {
  const worker = yield* WorkersBuilds.Worker("Worker", { name: "my-app" }).pipe(
    Alchemy.RemovalPolicy.retain(),
  );
  // ...
});
```

- Alchemy then does not delete the Worker. It removes the Worker from state, and the plan shows the
  Worker as `orphaned`.
- This also applies to an adopted Worker, because Alchemy destroys adopted and created resources in
  the same way.
- A replacement, such as a new `name`, then also keeps the old Worker.
- The policy is not a prop, so the plan shows no change. The next deploy writes it to state. Deploy
  once after you add it, before you destroy.
- Destroy still deletes the `WorkersBuilds.Repository` and `WorkersBuilds.Secret` resources of the
  Worker. Each deleted secret makes a new version of the Worker without that secret. `retain()`
  applies to each resource that the piped effect declares, so you can wrap all of them in one
  `Effect.gen` block.

## Resources

### `WorkersBuilds.Worker`

Calls `POST`, `GET`, `PATCH`, and `DELETE /accounts/{account_id}/workers/workers[/{worker_id}]`
and `GET /accounts/{account_id}/workers/subdomain`.

| Prop            | Default                                              | Change  |
| --------------- | ---------------------------------------------------- | ------- |
| `name`          | made by Alchemy, see [Without `name`](#without-name) | replace |
| `subdomain`     | `{ enabled: true, previewsEnabled: true }`           | update  |
| `observability` | persisted invocation logs, no traces                 | update  |
| `logpush`       | `false`                                              | update  |
| `tags`          | `[]`                                                 | update  |
| `tailConsumers` | `[]`                                                 | update  |

Outputs: `workerId` (the Worker tag), `name`, `url`
(`https://<name>.<account subdomain>.workers.dev`), `accountId`, and each setting that the props
declare, as Cloudflare reports it. See [What drift detection sees](#what-drift-detection-sees).

- Defaults apply on create only. An update sends only the props that you set.
- Destroy deletes the Worker with all of its versions, deployments, and preview URLs. A Worker that
  is already gone is not an error. To keep the Worker, see
  [Keep the Worker on destroy](#keep-the-worker-on-destroy).
- A new explicit `name` creates a new Worker, and then deletes the old Worker.
- An existing Worker with the same name is adopted only with `--adopt`. A made name is new, so
  nothing is adopted without `name`.

### `WorkersBuilds.Repository`

Calls `GET`, `POST`, `PATCH`, and `DELETE /accounts/{account_id}/builds/workers[/{script_tag}]`,
`POST .../builds/workers/{script_tag}/migrate_to_previews`, `GET` and `POST .../builds/tokens`,
`GET /user/tokens/verify`, `GET .../builds/workers/{script_tag}/triggers`,
`DELETE .../builds/triggers/{trigger_uuid}`, and `GET https://api.github.com/repos/{owner}/{name}`.

| Prop                                  | Default                   | Change                                          |
| ------------------------------------- | ------------------------- | ----------------------------------------------- |
| `worker`                              | required                  | replace, see Another Worker below               |
| `repository`                          | the repository of the run | see [Without `repository`](#without-repository) |
| `repository.owner`, `.name`           | required in `repository`  | update, see Renames below                       |
| `repository.branch`                   | default branch on GitHub  | update                                          |
| `repository.ownerId`, `.repositoryId` | read from GitHub          | update, see Another repository below            |
| `buildCommand`                        | required                  | update                                          |
| `deployCommand`                       | `npx wrangler deploy`     | update                                          |
| `previewDeployCommand`                | `npx wrangler preview`    | update                                          |
| `rootDirectory`                       | `/`                       | update                                          |
| `pathIncludes`                        | `["*"]`                   | update                                          |
| `pathExcludes`                        | `[]`                      | update                                          |
| `buildCachingEnabled`                 | `true`                    | update                                          |
| `buildToken`                          | see below                 | update                                          |
| `previews`                            | `true`                    | update                                          |
| `variables`                           | none                      | update                                          |
| `previewVariables`                    | none                      | update                                          |

Outputs: `scriptTag`, `repoConnectionId`, `triggerIds`, `previewsEnabled`, `accountId`,
`repository` (the repository that the configuration builds from, with its GitHub ids, and the
production branch), and `production` and `preview` (the build settings). See
[What drift detection sees](#what-drift-detection-sees).

- No replacement for the same Worker: every change is an update of the one configuration. Workers
  Builds keeps one configuration per Worker, and Alchemy creates a replacement before it deletes
  the old resource. A replacement for the same Worker would update the configuration and then
  delete it.
- GitHub ids: Workers Builds addresses a repository by its numeric GitHub ids. Without `ownerId`,
  `repositoryId`, and `branch`, the provider reads them from the GitHub API with `GITHUB_TOKEN` or
  `GITHUB_ACCESS_TOKEN`, or without a token for a public repository. The plan reads them once per
  deploy, and the deploy uses the same result.
- Renames: GitHub keeps the repository id when a repository gets a new name or owner. The plan
  compares the id of the new name with the id that the configuration builds from. The same id is
  an update of the same configuration: one PATCH, and no delete. The props need no ids for this.
  Workers Builds keeps the old names in the configuration; the builds continue.
- Another repository: another repository id is also an update. The deploy deletes the build
  triggers and the configuration, and then creates the configuration for the new repository, in
  that order. The new configuration keeps the build token. Variables that someone else added are
  gone. If the create fails, the next deploy creates the configuration with the saved build token.
  Only an explicit `repository` prop moves the builds to another repository. State from 0.4 has no
  saved build token, so the first move after the upgrade needs `buildToken`, or one deploy without
  the move first.
- A configuration that is gone or moved: the plan reads the configuration of the Worker. When it
  is gone, or builds from another repository, such as after someone changed it or after a move or
  repair that failed halfway, the plan shows an update, and the deploy completes it. Without
  `repository`, the deploy creates a configuration again only for the repository in state. When
  the state has no saved build token (state from 0.4), it needs `buildToken` for that.
- Another Worker: another `worker` or account replaces the resource. That is another
  configuration, so Alchemy creates it and then deletes the old one. `Alchemy.RemovalPolicy.retain()`
  keeps the old one. When the same deploy replaces the `WorkersBuilds.Worker`, the plan does not
  know the new Worker tag yet. Then the deploy updates the resource: it creates the configuration
  of the new Worker and does not delete the configuration of the old Worker. Alchemy then deletes
  the old Worker, unless it is retained.
- Build token: Workers Builds deploys with the API token behind a build token. Without
  `buildToken`, a new configuration uses the account's first build token (by name, newest first),
  and an existing configuration keeps its token. If the account has no build token, the provider
  registers the stack's API token (`CLOUDFLARE_API_TOKEN`) as a build token named
  `alchemy-<stack name>`, with the token id from `GET /user/tokens/verify`. The token then needs
  the permissions of the deploy, see [Credentials](#credentials). Destroy keeps the build token,
  because build tokens belong to the account and other configurations can use them. Workers Builds
  accepts only API tokens: with the OAuth login or a global API key, the provider cannot register
  one, and the deploy fails with `WorkersBuildsError`.
- Previews: with `previews: true`, Cloudflare builds a preview deployment with its own URL for each
  branch. Cloudflare can create legacy branch triggers even when the request enables previews. The
  provider then calls `migrate_to_previews`.
- Variables: `variables` apply to production and preview builds. `previewVariables` replace keys of
  `variables` in preview builds. `Redacted` values are written as secrets, which Cloudflare never
  returns. A key that you remove is removed on the next deploy. Variables that someone else added
  stay.
- Destroy removes the build triggers and the build configuration. It keeps the Worker and the
  repository connection, because every Worker that builds from the same repository shares that
  connection.
- An existing configuration for the Worker is adopted only with `--adopt`. If an adopted
  configuration builds from another repository, the deploy fails with `WorkersBuildsError`. The
  provider moves only a configuration that it wrote.

### `WorkersBuilds.Secret`

Calls `PUT` and `GET /accounts/{account_id}/workers/scripts/{script_name}/secrets` and
`DELETE .../workers/scripts/{script_name}/secrets/{secret_name}`.

| Prop     | Default  | Change  |
| -------- | -------- | ------- |
| `worker` | required | replace |
| `name`   | required | replace |
| `value`  | required | update  |

Outputs: `workerName`, `name`, `accountId`.

- Worker: these endpoints address the Worker by its name. Pass `worker.name` of a
  `WorkersBuilds.Worker`. The Worker must exist. If it does not, the write fails with
  `WorkersBuildsError`.
- Value: a `Redacted` string, such as `Config.Redacted("API_KEY")`. Cloudflare never returns a
  value, so the provider reads only the names. A new value is written on the next deploy.
- Versions: each write and each delete creates a new version of the Worker. Wrangler keeps secrets
  on deploy, so the next build keeps the secret.
- Destroy deletes the secret. A secret or Worker that is already gone is not an error.
- An existing secret with the same name is adopted only with `--adopt`. The first deploy after
  `--adopt` writes the value.

## What drift detection sees

`alchemy drift` and `alchemy deploy --detect-drift` read each resource from Cloudflare and compare
the result with the attributes in state. A difference is drift. The repair writes the props of the
last deploy again.

- `WorkersBuilds.Repository`: the repository and its GitHub ids, the production branch, the
  triggers, the repository connection, Worker Previews, and for production and preview builds: the
  build command, the deploy command, the root directory, the path filters, build caching, the build
  token, and the names of the variables, each `"secret"` or `"plain"`.
- `WorkersBuilds.Worker`: only the settings that the props declare: `subdomain`, `observability`
  (each field that Cloudflare reports), `logpush`, `tags`, and `tailConsumers`. A setting that the
  props leave out is not drift, because the Wrangler file can own it.
- `WorkersBuilds.Secret`: only that the name exists.

Variable values are not in the attributes. Cloudflare never returns a secret value, so a changed
secret value cannot be seen. The attributes also show in plans and drift reports, so they hold no
value. Thus a changed value is not drift. A removed variable, an added variable, and a variable
that changed between plain and secret are drift. To write all values again, run
`alchemy deploy --force`.

The repair keeps a variable that someone else added, as a deploy does, and saves its name in the
attributes. The next drift check then shows no drift.

The first deploy after an upgrade from 0.4 is an update of each `WorkersBuilds.Repository`, and of
each `WorkersBuilds.Worker` that declares a setting. It saves the new attributes.

## Limits

- GitHub only. Workers Builds also supports GitLab; this package does not.
- The package never creates an API token. It registers only the stack's own API token as a build
  token. No live run has registered a build token yet.
- Secret build variables and `WorkersBuilds.Secret` values are part of Alchemy state. Alchemy's
  Cloudflare state store encrypts state at rest; the local file store does not.
- Turning `previews` from `true` to `false` sends `previews_enabled: false`. The live tests do not
  cover this case yet.
- A secret on a Worker that has no version yet, such as a new shell before its first build, is not
  proven. `secret.live.test.ts` covers this case. It has not run yet.

## Development

```sh
pnpm install
pnpm run check            # format, lint, typecheck, unit tests
pnpm run build            # lib/ with declarations, then publint and attw
pnpm run test:live        # real API calls, see below
```

Use Node 24 (`.node-version`) and pnpm 11. `pnpm install` also installs a pre-commit hook that
runs `vp staged`.

Unit tests run against recorded Cloudflare and GitHub payloads in `test/fixtures/`, and against
secret and build token payloads that follow Cloudflare's API schema until a live run records them.
They make no network calls.

Live tests run only with `ALCHEMY_WORKERS_BUILDS_LIVE=1`, which `pnpm run test:live` sets:

- `permission.live.test.ts` needs only the network. It runs a plan through the Alchemy engine with
  a placeholder token and expects `WorkersBuildsPermissionError`.
- `workers-builds.live.test.ts` needs `CLOUDFLARE_API_TOKEN` with the permissions above and a
  GitHub repository that the Cloudflare GitHub App can read. The defaults are in
  `test/live/env.ts`. It creates resources named `tmp-alchemy-workers-builds-*` and removes them
  again.
- `secret.live.test.ts` needs `CLOUDFLARE_API_TOKEN` with the permissions above and no GitHub
  repository. It creates a Worker shell named `tmp-alchemy-workers-builds-secret-*`, writes,
  updates, and deletes a secret on it, and deletes the Worker.

Releases: change `version` in `package.json` in a pull request. After the merge,
`.github/workflows/release.yml` publishes that version from `main` with npm trusted publishing.

## License

Apache 2.0.
