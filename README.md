# @samebase/alchemy-cloudflare-workers

[Alchemy v2](https://alchemy.run) resources for Cloudflare Workers that
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) deploys from a Git
repository. Use them when the repository's `wrangler.jsonc` defines the Worker and Cloudflare
builds each commit.

The package adds only what the built-in `alchemy/Cloudflare` provider does not have:

- `WorkersBuilds.Worker`: a Worker that exists without code.
- `WorkersBuilds.Repository`: the Workers Builds configuration that links a GitHub repository to
  that Worker.

This is a community provider, maintained by [Samebase](https://samebase.com).

Status: 0.1, pinned to `alchemy@2.0.0-beta.80` and Effect 4. Alchemy ships breaking changes
between betas. Upgrade this package and Alchemy together.

## Ownership rule

Wrangler owns the version. This package owns the shell and the link.

- The Wrangler file in the repository is the only source of truth for the code, bindings, vars,
  assets, routes, and compatibility settings. Alchemy never uploads code and never writes these.
- Workers Builds runs `npx wrangler deploy` on each push to the production branch and
  `npx wrangler preview` on each other branch.
- This package creates the Worker shell, links the repository, sets the build commands, and writes
  the build variables.

Wrangler also writes some Worker settings on each deploy: `observability`, `logpush`,
`workers_dev`, and `preview_urls`. `WorkersBuilds.Worker` writes a setting after create only when
its props name it. If the Wrangler file names a setting, do not set it on the resource. Then the
two never write different values.

## Install

```sh
pnpm add -D @samebase/alchemy-cloudflare-workers alchemy@2.0.0-beta.80 effect@^4.0.0 @effect/platform-node@^4.0.0
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

The Cloudflare Workers and Pages GitHub App must have access to the repository. Install it once from
**Workers & Pages** in the Cloudflare dashboard.

## Example

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkersBuilds from "@samebase/alchemy-cloudflare-workers";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), WorkersBuilds.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // The name must match `name` in the repository's wrangler.jsonc.
    const worker = yield* WorkersBuilds.Worker("Worker", { name: "my-app" });

    const builds = yield* WorkersBuilds.Repository("Builds", {
      worker: worker.workerId,
      repository: { owner: "my-org", name: "my-app", branch: "main" },
      buildCommand: "pnpm install && pnpm run build",
      variables: { CONVEX_DEPLOY_KEY: Config.Redacted("CONVEX_DEPLOY_KEY") },
      previewVariables: { CONVEX_DEPLOY_KEY: Config.Redacted("CONVEX_PREVIEW_DEPLOY_KEY") },
    });

    return { url: worker.url, triggerIds: builds.triggerIds };
  }),
);
```

Alchemy creates the Worker first, because the configuration uses `worker.workerId`. The Worker has
no version until Workers Builds builds the next push to `main`.

## Resources

### `WorkersBuilds.Worker`

Calls `POST`, `GET`, `PATCH`, and `DELETE /accounts/{account_id}/workers/workers[/{worker_id}]`
and `GET /accounts/{account_id}/workers/subdomain`.

| Prop            | Default                                    | Change  |
| --------------- | ------------------------------------------ | ------- |
| `name`          | required                                   | replace |
| `subdomain`     | `{ enabled: true, previewsEnabled: true }` | update  |
| `observability` | persisted invocation logs, no traces       | update  |
| `logpush`       | `false`                                    | update  |
| `tags`          | `[]`                                       | update  |
| `tailConsumers` | `[]`                                       | update  |
| `delete`        | `false`                                    | update  |

Outputs: `workerId` (the Worker tag), `name`, `url`
(`https://<name>.<account subdomain>.workers.dev`), `accountId`.

- Defaults apply on create only. An update sends only the props that you set.
- Destroy keeps the Worker unless `delete` is `true`. Deleting a Worker deletes all of its
  versions, deployments, and preview URLs.
- A new `name` creates a new Worker. The old Worker stays unless `delete` is `true`.
- An existing Worker with the same name is adopted only with `--adopt`.

### `WorkersBuilds.Repository`

Calls `GET`, `POST`, `PATCH`, and `DELETE /accounts/{account_id}/builds/workers[/{script_tag}]`,
`POST .../builds/workers/{script_tag}/migrate_to_previews`, `GET .../builds/tokens`,
`GET .../builds/workers/{script_tag}/triggers`, `DELETE .../builds/triggers/{trigger_uuid}`, and
`GET https://api.github.com/repos/{owner}/{name}`.

| Prop                                  | Default                | Change                      |
| ------------------------------------- | ---------------------- | --------------------------- |
| `worker`                              | required               | replace                     |
| `repository.owner`, `.name`           | required               | replace                     |
| `repository.branch`                   | required               | update                      |
| `repository.ownerId`, `.repositoryId` | read from GitHub       | replace when the id changes |
| `buildCommand`                        | required               | update                      |
| `deployCommand`                       | `npx wrangler deploy`  | update                      |
| `previewDeployCommand`                | `npx wrangler preview` | update                      |
| `rootDirectory`                       | `/`                    | update                      |
| `pathIncludes`                        | `["*"]`                | update                      |
| `pathExcludes`                        | `[]`                   | update                      |
| `buildCachingEnabled`                 | `true`                 | update                      |
| `buildToken`                          | see below              | update                      |
| `previews`                            | `true`                 | update                      |
| `variables`                           | none                   | update                      |
| `previewVariables`                    | none                   | update                      |

Outputs: `scriptTag`, `repoConnectionId`, `triggerIds`, `previewsEnabled`, `accountId`.

- GitHub ids: Workers Builds addresses a repository by its numeric GitHub ids. Without `ownerId`
  and `repositoryId`, the provider reads them from the GitHub API with `GITHUB_TOKEN` or
  `GITHUB_ACCESS_TOKEN`, or without a token for a public repository.
- Build token: Workers Builds deploys with the API token behind a build token. Without
  `buildToken`, a new configuration uses the account's first build token (by name, newest first),
  and an existing configuration keeps its token. If the account has no build token, connect any
  Worker to Git once in the dashboard. Cloudflare then creates one.
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
- An existing configuration for the Worker is adopted only with `--adopt`, and only when it builds
  from the same repository.

## Limits

- GitHub only. Workers Builds also supports GitLab; this package does not.
- The package cannot create a build token. A build token wraps an account API token, and creating
  one needs more permissions than the three above.
- Secret build variables are part of Alchemy state. Alchemy's Cloudflare state store encrypts
  state at rest; the local file store does not.
- Turning `previews` from `true` to `false` sends `previews_enabled: false`. The live tests do not
  cover this case yet.

## Development

```sh
pnpm install
pnpm run check            # format, lint, typecheck, unit tests
pnpm run build            # lib/ with declarations
pnpm run test:live        # real API calls, see below
```

Unit tests run against recorded Cloudflare and GitHub payloads in `test/fixtures/`. They make no
network calls.

Live tests run only with `ALCHEMY_WORKERS_BUILDS_LIVE=1`:

- `permission.live.test.ts` needs only the network. It runs a plan through the Alchemy engine with
  a placeholder token and expects `WorkersBuildsPermissionError`.
- `workers-builds.live.test.ts` needs `CLOUDFLARE_API_TOKEN` with the permissions above and a
  GitHub repository that the Cloudflare GitHub App can read. The defaults are in
  `test/live/env.ts`. It creates resources named `tmp-alchemy-workers-builds-*` and removes them
  again.

Releases: push a `v*` tag; `.github/workflows/release.yml` publishes with npm trusted publishing.

## License

Apache 2.0.
