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

## Cloudflare, from the API schema

No call recorded these files yet. The success files follow the response schema in Cloudflare's
OpenAPI document. Secret values are write-only in that schema, so a response never holds one. The
error file uses code 10007, which distilled maps to `WorkerNotFound` on these endpoints, with the
message that the Samebase tests hold for that code. Its HTTP status is not known, so the tests send
it with 400 and with 404. Replace each file with a recording when the secret live test runs.

| File                                   | Endpoint                                                                         | Source                                  |
| -------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `workers_scripts_secrets_list.json`    | GET /accounts/{account_id}/workers/scripts/{script_name}/secrets                 | OpenAPI `worker-list-script-secrets`    |
| `workers_scripts_secrets_put.json`     | PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets                 | OpenAPI `worker-put-script-secret`      |
| `workers_scripts_not_found_error.json` | /accounts/{account_id}/workers/scripts/{script_name}/... and DELETE /accounts/{account_id}/workers/workers/{worker_id}, Worker does not exist | code 10007, Samebase test message       |
| `user_tokens_verify.json`              | GET /user/tokens/verify                                                          | OpenAPI `user-api-tokens-verify-token`  |
| `builds_tokens_create.json`            | POST /accounts/{account_id}/builds/tokens                                        | OpenAPI `createBuildToken`              |
| `workers_workers_get.json`             | GET /accounts/{account_id}/workers/workers/{worker_id}                           | OpenAPI `getWorker`                     |

The Worker file is the example of the schema without `previews_base_config` and
`observability.issues`, which the provider does not read. It has dates in place of the `string`
placeholders, `false` in place of the `boolean` placeholder, and `null` for
`traces.propagation_policy`, which the schema returns when the account has no trace propagation. `test/engine.ts` uses it as the start
of each Worker that its fake API creates.

The verify file is the example of the schema. The create file has the uuid of the documentation
example, the token id of the verify file, and the name that the provider sends for the stack
`MyApp`. A list item of GET /accounts/{account_id}/builds/tokens has the same fields, so the tests
also send it as the list. The create result never holds the token secret.

## GitHub

| File                    | Endpoint                                                                         | Captured   |
| ----------------------- | -------------------------------------------------------------------------------- | ---------- |
| `github/repos_get.json` | GET https://api.github.com/repos/samebase-live-tests/tmp-plugin-review-9806-20260905-1434 | 2026-10-05 |

Recorded with `gh api`. Fields that the provider does not read are omitted. The repository and
owner ids match `repo_id` and `provider_account_id` in `cloudflare/builds_workers_get_legacy.json`.
