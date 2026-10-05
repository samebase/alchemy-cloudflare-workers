// Targets for the live tests. They only run with ALCHEMY_WORKERS_BUILDS_LIVE=1
// and CLOUDFLARE_API_TOKEN set to a user-scoped token with the permissions in
// TOKEN_PERMISSIONS. The defaults are the Samebase live-test account and
// GitHub organization; override them with env vars.
//
// One-time setup of the GitHub repository (the Cloudflare Workers and Pages
// GitHub App must have access to it):
//   gh repo create samebase-live-tests/tmp-alchemy-workers-builds-live --private
//   then push a `wrangler.jsonc` and a `src/index.ts` that returns a response.
export const liveEnabled = process.env["ALCHEMY_WORKERS_BUILDS_LIVE"] === "1";

export const liveTargets = {
  accountId:
    process.env["ALCHEMY_WORKERS_BUILDS_LIVE_ACCOUNT_ID"] ?? "fe57d01d7ab41f60d00ba1aade20eb33",
  owner: process.env["ALCHEMY_WORKERS_BUILDS_LIVE_OWNER"] ?? "samebase-live-tests",
  repository:
    process.env["ALCHEMY_WORKERS_BUILDS_LIVE_REPOSITORY"] ?? "tmp-alchemy-workers-builds-live",
  branch: process.env["ALCHEMY_WORKERS_BUILDS_LIVE_BRANCH"] ?? "main",
};
