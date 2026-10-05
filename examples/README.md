# Examples

Each folder is a complete `alchemy.run.ts` that imports this package from source, so it tracks
the checkout. In your own app, import `@samebase/alchemy-cloudflare-workers-builds` instead.

- `worker/`: one Worker shell and its Workers Builds link, with local state. Set
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `EXAMPLE_BUILD_SECRET`, then run
  `npx alchemy deploy --stage dev` inside the folder, and `npx alchemy destroy --stage dev` after.
  The repository `samebase-live-tests/tmp-alchemy-workers-builds-live` must exist and the
  Cloudflare GitHub App must have access to it. Change `repository` to use your own.
