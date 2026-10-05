# Changelog

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
