import { readFileSync } from "node:fs";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";
import { WorkersBuildsError } from "../src/Api.ts";
import {
  createBody,
  diffRepository,
  GitHubRepositoryResponse,
  type RepositoryAttributes,
  type RepositoryProps,
  resolveRepositoryIds,
  selectBuildToken,
  triggerAttributes,
  updateBody,
  WorkerBuilds,
} from "../src/Repository.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

const accountId = "fe57d01d7ab41f60d00ba1aade20eb33";
const legacy = Schema.decodeUnknownSync(WorkerBuilds)(
  fixture("cloudflare/builds_workers_get_legacy.json"),
);

const props: RepositoryProps = {
  worker: legacy.script_tag,
  repository: {
    owner: "samebase-live-tests",
    name: "tmp-plugin-review-9806-20260905-1434",
    branch: "main",
  },
  buildCommand: "pnpm run build",
};

describe("WorkerBuilds", () => {
  it.each([
    ["builds_workers_create.json", false],
    ["builds_workers_migrate_to_previews.json", true],
    ["builds_workers_get_native.json", true],
    ["builds_workers_get_legacy.json", false],
  ])("decodes the recorded %s", (file, previewsEnabled) => {
    const builds = Schema.decodeUnknownSync(WorkerBuilds)(fixture(`cloudflare/${file}`));
    expect(builds.previews_enabled).toBe(previewsEnabled);
    expect(builds.git_repository.provider_type).toBe("github");
  });
});

describe("createBody", () => {
  it("links the repository by its GitHub ids and applies the defaults", () => {
    const body = createBody({
      scriptTag: legacy.script_tag,
      props,
      ids: { ownerId: "315958746", repositoryId: "1358278395" },
      buildToken: legacy.production_settings.build_token_uuid,
    });
    const settings = {
      build_command: "pnpm run build",
      root_directory: "/",
      path_includes: ["*"],
      path_excludes: [],
      build_caching_enabled: true,
      build_token_uuid: "bf34959e-03df-446a-af6d-b55bff91ab8b",
      environment_variables: {},
    };
    expect(body).toEqual({
      script_tag: "3717c592bb564236a6815df01f084963",
      git_repository: {
        provider_type: "github",
        provider_account_id: "315958746",
        provider_account_name: "samebase-live-tests",
        repo_id: "1358278395",
        repo_name: "tmp-plugin-review-9806-20260905-1434",
        branch: "main",
      },
      production_settings: { ...settings, deploy_command: "npx wrangler deploy" },
      previews_base_config: { ...settings, deploy_command: "npx wrangler preview" },
      previews_enabled: true,
    });
  });

  it("writes Redacted values as secrets and lets preview values replace production ones", () => {
    const body = createBody({
      scriptTag: legacy.script_tag,
      props: {
        ...props,
        variables: { GREETING: "hello", CONVEX_DEPLOY_KEY: Redacted.make("prod-key") },
        previewVariables: { CONVEX_DEPLOY_KEY: Redacted.make("preview-key") },
      },
      ids: { ownerId: "315958746", repositoryId: "1358278395" },
      buildToken: legacy.production_settings.build_token_uuid,
    });
    expect(body.production_settings.environment_variables).toEqual({
      GREETING: { value: "hello", is_secret: false },
      CONVEX_DEPLOY_KEY: { value: "prod-key", is_secret: true },
    });
    expect(body.previews_base_config.environment_variables).toEqual({
      GREETING: { value: "hello", is_secret: false },
      CONVEX_DEPLOY_KEY: { value: "preview-key", is_secret: true },
    });
  });
});

describe("updateBody", () => {
  const buildToken = legacy.production_settings.build_token_uuid;

  it("removes the variables that the previous props declared and the new props drop", () => {
    const body = updateBody({
      olds: {
        ...props,
        variables: { KEEP: "1", DROP: "2" },
        previewVariables: { PREVIEW_ONLY: "3" },
      },
      news: { ...props, variables: { KEEP: "1" } },
      buildToken,
    });
    expect(body.production_settings.environment_variables).toEqual({
      DROP: null,
      KEEP: { value: "1", is_secret: false },
    });
    expect(body.previews_base_config.environment_variables).toEqual({
      DROP: null,
      PREVIEW_ONLY: null,
      KEEP: { value: "1", is_secret: false },
    });
  });

  it("removes nothing without previous props, such as after --adopt", () => {
    const body = updateBody({ olds: undefined, news: props, buildToken });
    expect(body.production_settings.environment_variables).toEqual({});
    expect(body.previews_base_config.environment_variables).toEqual({});
  });

  it("changes the production branch, commands, paths, and previews in one request", () => {
    const body = updateBody({
      olds: props,
      news: {
        ...props,
        repository: { ...props.repository, branch: "release" },
        deployCommand: "pnpm run deploy",
        previewDeployCommand: "pnpm run deploy:preview",
        rootDirectory: "apps/web",
        pathExcludes: ["*.md"],
        buildCachingEnabled: false,
        previews: false,
      },
      buildToken,
    });
    expect(body).toMatchObject({
      git_repository: { branch: "release" },
      production_settings: {
        deploy_command: "pnpm run deploy",
        root_directory: "apps/web",
        path_excludes: ["*.md"],
        build_caching_enabled: false,
      },
      previews_base_config: { deploy_command: "pnpm run deploy:preview" },
      previews_enabled: false,
    });
  });
});

describe("diffRepository", () => {
  const output: RepositoryAttributes = {
    scriptTag: legacy.script_tag,
    repoConnectionId: undefined,
    triggerIds: [],
    previewsEnabled: false,
    accountId,
  };

  it.each([
    ["another Worker", { ...props, worker: "eaeec9c35fa64976a823c246164f4204" }],
    ["another owner", { ...props, repository: { ...props.repository, owner: "samebase" } }],
    ["another repository", { ...props, repository: { ...props.repository, name: "other" } }],
  ])("replaces the configuration for %s", (_, news) => {
    expect(diffRepository({ olds: props, news, output, accountId })).toEqual({
      action: "replace",
    });
  });

  it("replaces the configuration for another repository id, and only then", () => {
    const pinned = { ...props, repository: { ...props.repository, repositoryId: 1358278395 } };
    const other = { ...props, repository: { ...props.repository, repositoryId: 1 } };
    expect(diffRepository({ olds: pinned, news: other, output, accountId })).toEqual({
      action: "replace",
    });
    expect(diffRepository({ olds: props, news: pinned, output, accountId })).toBeUndefined();
    const renamed = { ...props, repository: { ...props.repository, owner: "Samebase-Live-Tests" } };
    expect(diffRepository({ olds: props, news: renamed, output, accountId })).toBeUndefined();
  });

  it("replaces the configuration for another account", () => {
    expect(
      diffRepository({
        olds: props,
        news: props,
        output,
        accountId: "00000000000000000000000000000000",
      }),
    ).toEqual({ action: "replace" });
  });

  it("leaves branch, command, variable, and previews changes to the engine as updates", () => {
    const news: RepositoryProps = {
      ...props,
      repository: { ...props.repository, branch: "release" },
      buildCommand: "npm run build",
      variables: { GREETING: Redacted.make("hi") },
      previews: false,
    };
    expect(diffRepository({ olds: props, news, output, accountId })).toBeUndefined();
  });
});

describe("selectBuildToken", () => {
  it("takes the newest name first, then the lowest uuid, and skips tokens without a uuid", () => {
    expect(
      selectBuildToken([
        {
          buildTokenName: "Workers Builds - 2026-09-05",
          buildTokenUuid: "bf34959e-03df-446a-af6d-b55bff91ab8b",
        },
        {
          buildTokenName: "Workers Builds - 2026-09-30",
          buildTokenUuid: "37ba157d-9fb1-4cf9-8382-4d9fe7d69816",
        },
        { buildTokenName: "Workers Builds - 2026-10-01", buildTokenUuid: null },
      ]),
    ).toBe("37ba157d-9fb1-4cf9-8382-4d9fe7d69816");
  });

  it("is undefined for an account without build tokens", () => {
    expect(selectBuildToken([])).toBeUndefined();
  });
});

describe("triggerAttributes", () => {
  it("lists active triggers in uuid order with their repository connection", () => {
    expect(
      triggerAttributes([
        {
          triggerUuid: "b595a215-7b9b-4a04-a55d-578f39ca4335",
          repoConnection: { repoConnectionUuid: "c1", repoId: "1358278395" },
        },
        { triggerUuid: "0d1e2f3a-0000-4000-8000-000000000000", deletedOn: "2026-10-01T00:00:00Z" },
        { triggerUuid: "a0000000-0000-4000-8000-000000000000", repoConnection: null },
      ]),
    ).toEqual({
      triggerIds: ["a0000000-0000-4000-8000-000000000000", "b595a215-7b9b-4a04-a55d-578f39ca4335"],
      repoConnectionId: "c1",
    });
  });
});

/** Serves `respond(request)` to every request and records the requests. */
const serve = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
  });
  return { requests, client };
};

const resolveWith = (
  client: HttpClient.HttpClient,
  env: Record<string, string>,
  repository: RepositoryProps["repository"] = props.repository,
) =>
  resolveRepositoryIds(repository).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );

describe("resolveRepositoryIds", () => {
  it("decodes the recorded GitHub payload", () => {
    const parsed = Schema.decodeUnknownSync(GitHubRepositoryResponse)(
      fixture("github/repos_get.json"),
    );
    expect(parsed).toEqual({ id: 1358278395, owner: { id: 315958746 } });
  });

  it("reads the ids that the recorded Builds configuration of the same repository holds", async () => {
    const github = serve(() => Response.json(fixture("github/repos_get.json")));
    const ids = await Effect.runPromise(resolveWith(github.client, {}));
    expect(ids).toEqual({ ownerId: "315958746", repositoryId: "1358278395" });
    const raw = fixture("cloudflare/builds_workers_get_legacy.json");
    expect(raw).toMatchObject({
      git_repository: { provider_account_id: ids.ownerId, repo_id: ids.repositoryId },
    });
    expect(github.requests[0]?.url).toBe(
      "https://api.github.com/repos/samebase-live-tests/tmp-plugin-review-9806-20260905-1434",
    );
    expect(github.requests[0]?.headers["authorization"]).toBeUndefined();
  });

  it("sends GITHUB_ACCESS_TOKEN when GITHUB_TOKEN is not set", async () => {
    const github = serve(() => Response.json(fixture("github/repos_get.json")));
    await Effect.runPromise(resolveWith(github.client, { GITHUB_ACCESS_TOKEN: "test-token" }));
    expect(github.requests[0]?.headers["authorization"]).toBe("Bearer test-token");
  });

  it("skips GitHub when the props hold both ids", async () => {
    const github = serve(() => new Response(null, { status: 500 }));
    const ids = await Effect.runPromise(
      resolveWith(github.client, {}, { ...props.repository, ownerId: 1, repositoryId: 2 }),
    );
    expect(ids).toEqual({ ownerId: "1", repositoryId: "2" });
    expect(github.requests).toHaveLength(0);
  });

  it("names the token and the id props when GitHub hides the repository", async () => {
    const github = serve(() => Response.json({ message: "Not Found" }, { status: 404 }));
    const error = await Effect.runPromise(Effect.flip(resolveWith(github.client, {})));
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error.message).toContain("GITHUB_TOKEN");
    expect(error.message).toContain("repository.repositoryId");
  });
});
