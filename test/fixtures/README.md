# Recorded API payloads

Unit tests only read these files. They never call an API. Negative cases are made by mutating a
recorded payload in the test, never written from scratch. Ids, tags, and uuids are real and
harmless. No file holds a secret: Cloudflare returns secret build variables as `null`.

## Cloudflare

Recorded by Samebase against the account of the `samebase-live-tests` organization and copied from
`apps/samebase/convex/cloudflareApi/fixtures/` in the Samebase repository. Success files hold the
envelope's `result` only. Error files hold the whole envelope. The HTTP status of the error
responses was not recorded, so the provider matches them by error code.

| File                                     | Endpoint                                                                     | Captured   |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| `builds_workers_create.json`             | POST /accounts/{account_id}/builds/workers, and the GET read-back            | 2026-09-30 |
| `builds_workers_migrate_to_previews.json` | POST /accounts/{account_id}/builds/workers/{script_tag}/migrate_to_previews | 2026-09-30 |
| `builds_workers_get_native.json`         | GET /accounts/{account_id}/builds/workers/{script_tag}, after a variable PATCH | 2026-09-30 |
| `builds_workers_get_legacy.json`         | GET /accounts/{account_id}/builds/workers/{script_tag}, legacy branch triggers | 2026-09-30 |
| `builds_workers_get_missing_error.json`  | GET /accounts/{account_id}/builds/workers/{script_tag}, Worker without Builds | 2026-09-30 |
| `builds_workers_patch_previews_error.json` | PATCH /accounts/{account_id}/builds/workers/{script_tag} with `previews_enabled: true` while a legacy trigger exists | 2026-09-30 |
| `workers_create_invalid_name_error.json` | POST /accounts/{account_id}/workers/workers with the name `samebase app`     | 2026-08-05 |
| `workers_create_name_too_long_error.json` | POST /accounts/{account_id}/workers/workers, previews on, 55-character name | 2026-08-05 |
| `workers_previews_get.json`              | GET /accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id} | 2026-09-30 |

Facts in these payloads: the create call returned `previews_enabled: false` with legacy triggers
although the request asked for previews, so the provider calls `migrate_to_previews` after create.
The account's `workers.dev` subdomain is `rir`, as the preview URL shows.

## GitHub

| File                    | Endpoint                                                                         | Captured   |
| ----------------------- | -------------------------------------------------------------------------------- | ---------- |
| `github/repos_get.json` | GET https://api.github.com/repos/samebase-live-tests/tmp-plugin-review-9806-20260905-1434 | 2026-10-05 |

Recorded with `gh api`. Fields that the provider does not read are omitted. The repository and
owner ids match `repo_id` and `provider_account_id` in `cloudflare/builds_workers_get_legacy.json`.
