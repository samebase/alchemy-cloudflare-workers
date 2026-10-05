import { readFileSync } from "node:fs";
import {
  Credentials,
  fromApiToken,
  oauthCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { Stack } from "alchemy/Stack";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect, it } from "vitest";
import { WorkersBuildsError } from "../src/Api.ts";
import {
  createBody,
  currentRepository,
  diffRepository,
  type GitHubRepository,
  GitHubRepositoryResponse,
  type RepositoryAttributes,
  type RepositoryProps,
  resolveBuildToken,
  resolveRepository,
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

const repository: GitHubRepository = {
  owner: "samebase-live-tests",
  name: "tmp-plugin-review-9806-20260905-1434",
  branch: "main",
};

const props: RepositoryProps = {
  worker: legacy.script_tag,
  repository,
  buildCommand: "pnpm run build",
};

/** The repository of the recorded GitHub payload, as `resolveRepository` returns it. */
const resolved = {
  owner: "samebase-live-tests",
  name: "tmp-plugin-review-9806-20260905-1434",
  branch: "main",
  ownerId: 315958746,
  repositoryId: 1358278395,
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
      repository: resolved,
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
      repository: resolved,
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
      branch: "main",
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
    const body = updateBody({ olds: undefined, news: props, branch: "main", buildToken });
    expect(body.production_settings.environment_variables).toEqual({});
    expect(body.previews_base_config.environment_variables).toEqual({});
  });

  it("changes the production branch, commands, paths, and previews in one request", () => {
    const body = updateBody({
      olds: props,
      news: {
        ...props,
        deployCommand: "pnpm run deploy",
        previewDeployCommand: "pnpm run deploy:preview",
        rootDirectory: "apps/web",
        pathExcludes: ["*.md"],
        buildCachingEnabled: false,
        previews: false,
      },
      branch: "release",
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
  /** The settings that `props` ask for, as Workers Builds reports them. */
  const settings = {
    buildCommand: "pnpm run build",
    deployCommand: "npx wrangler deploy",
    rootDirectory: "/",
    pathIncludes: ["*"],
    pathExcludes: [],
    buildCachingEnabled: true,
    buildToken: legacy.production_settings.build_token_uuid,
    variables: {},
  };
  const output: RepositoryAttributes = {
    scriptTag: legacy.script_tag,
    repoConnectionId: undefined,
    triggerIds: [],
    previewsEnabled: true,
    accountId,
    repository: resolved,
    production: settings,
    preview: { ...settings, deployCommand: "npx wrangler preview" },
  };
  const diff = (news: RepositoryProps, target = resolved) =>
    diffRepository({ olds: props, news, output, accountId, target });
  const keepsAll = { action: "update", stables: ["scriptTag", "repoConnectionId", "accountId"] };

  it("is no change when the props and the resolved repository match the configuration", () => {
    expect(diff(props)).toBeUndefined();
  });

  it("updates a renamed repository, by the id that GitHub keeps, whatever side has the ids", () => {
    const renamed = { ...resolved, owner: "samebase", name: "renamed" };
    const { ownerId: _, repositoryId: __, ...names } = renamed;
    for (const repository of [names, renamed]) {
      expect(diff({ ...props, repository }, renamed)).toEqual(keepsAll);
    }
  });

  it("updates, and never replaces, for another repository id", () => {
    const other = { ...resolved, name: "other", repositoryId: 1 };
    expect(diff({ ...props, repository: other }, other)).toEqual({
      action: "update",
      stables: ["scriptTag", "accountId"],
    });
  });

  it("updates when the repository of the run changed and the props did not", () => {
    const { repository: _, ...current } = props;
    const fork = { ...resolved, owner: "someone", repositoryId: 2 };
    expect(
      diffRepository({ olds: current, news: current, output, accountId, target: fork }),
    ).toEqual({ action: "update", stables: ["scriptTag", "accountId"] });
  });

  it("updates when the default branch on GitHub changed", () => {
    const { branch: _, ...withoutBranch } = repository;
    const news = { ...props, repository: withoutBranch };
    expect(
      diffRepository({
        olds: news,
        news,
        output,
        accountId,
        target: { ...resolved, branch: "trunk" },
      }),
    ).toEqual(keepsAll);
  });

  it("updates, and never replaces, for another Worker or account", () => {
    const moved = { action: "update", stables: [] };
    expect(diff({ ...props, worker: "eaeec9c35fa64976a823c246164f4204" })).toEqual(moved);
    expect(
      diffRepository({
        olds: props,
        news: props,
        output,
        accountId: "00000000000000000000000000000000",
        target: resolved,
      }),
    ).toEqual(moved);
  });

  it("updates for branch, command, variable, and previews changes", () => {
    const news: RepositoryProps = {
      ...props,
      repository: { ...repository, branch: "release" },
      buildCommand: "npm run build",
      variables: { GREETING: Redacted.make("hi") },
      previews: false,
    };
    expect(diff(news, { ...resolved, branch: "release" })).toEqual(keepsAll);
  });

  it("updates when the saved settings differ from the props", () => {
    const changed = [
      { ...output, production: { ...settings, buildCommand: "npm run build" } },
      { ...output, preview: { ...output.preview, pathIncludes: ["src/*"] } },
      { ...output, previewsEnabled: false },
    ];
    for (const saved of changed) {
      expect(
        diffRepository({ olds: props, news: props, output: saved, accountId, target: resolved }),
      ).toEqual(keepsAll);
    }
  });

  it("compares the variables that the props name, by kind, and the token only when named", () => {
    const news: RepositoryProps = {
      ...props,
      variables: { GREETING: "hello", CONVEX_DEPLOY_KEY: Redacted.make("key") },
    };
    const variables = { CONVEX_DEPLOY_KEY: "secret", GREETING: "plain" } as const;
    const saved = (production: Partial<typeof settings>) => ({
      ...output,
      production: { ...settings, variables, ...production },
      preview: { ...output.preview, variables },
    });
    const diffFrom = (from: RepositoryAttributes) =>
      diffRepository({ olds: news, news, output: from, accountId, target: resolved });

    // Someone else's variable and another build token stay: no change.
    expect(
      diffFrom(saved({ variables: { ...variables, OTHER: "plain" }, buildToken: "other" })),
    ).toBeUndefined();
    // A removed or retyped variable is a change.
    expect(diffFrom(saved({ variables: { GREETING: "plain" } }))).toEqual(keepsAll);
    expect(diffFrom(saved({ variables: { ...variables, GREETING: "secret" } }))).toEqual(keepsAll);
    // A token that the props name counts.
    const pinned = { ...news, buildToken: settings.buildToken };
    expect(
      diffRepository({
        olds: pinned,
        news: pinned,
        output: saved({ buildToken: "other" }),
        accountId,
        target: resolved,
      }),
    ).toEqual(keepsAll);
  });

  it("updates state from 0.4, which has no repository or settings in its attributes, to save them", () => {
    const { repository: _, production: __, preview: ___, ...before } = output;
    expect(
      diffRepository({ olds: props, news: props, output: before, accountId, target: resolved }),
    ).toEqual({ action: "update", stables: ["scriptTag", "accountId"] });
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

/** A git that prints `stdout` for every command and records the commands. */
const git = (stdout: string) => {
  const commands: ChildProcess.Command[] = [];
  const spawner = ChildProcessSpawner.make((command) => {
    commands.push(command);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  return { commands, spawner };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner>,
  input: {
    readonly github: ReturnType<typeof serve>;
    readonly env?: Record<string, string>;
    readonly origin?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
) =>
  effect.pipe(
    Effect.provideService(HttpClient.HttpClient, input.github.client),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.origin ?? git("").spawner),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(input.env ?? {}),
    ),
  );

const recordedRepository = () => serve(() => Response.json(fixture("github/repos_get.json")));

const recordedUrl =
  "https://api.github.com/repos/samebase-live-tests/tmp-plugin-review-9806-20260905-1434";

describe("resolveRepository", () => {
  it("decodes the recorded GitHub payload", () => {
    const parsed = Schema.decodeUnknownSync(GitHubRepositoryResponse)(
      fixture("github/repos_get.json"),
    );
    expect(parsed).toEqual({
      id: 1358278395,
      name: "tmp-plugin-review-9806-20260905-1434",
      default_branch: "main",
      owner: { id: 315958746, login: "samebase-live-tests" },
    });
  });

  it("reads the ids that the recorded Builds configuration of the same repository holds", async () => {
    const github = recordedRepository();
    const target = await Effect.runPromise(run(resolveRepository(repository), { github }));
    expect(target).toEqual(resolved);
    expect(fixture("cloudflare/builds_workers_get_legacy.json")).toMatchObject({
      git_repository: {
        provider_account_id: String(target.ownerId),
        repo_id: String(target.repositoryId),
      },
    });
    expect(github.requests[0]?.url).toBe(recordedUrl);
    expect(github.requests[0]?.headers["authorization"]).toBeUndefined();
  });

  it("takes the default branch from the same GitHub call when branch is absent", async () => {
    const github = recordedRepository();
    const { branch: _, ...ids } = resolved;
    const target = await Effect.runPromise(run(resolveRepository(ids), { github }));
    expect(target).toEqual(resolved);
    expect(github.requests).toHaveLength(1);
  });

  it("keeps the branch and the ids that the props hold over GitHub's", async () => {
    const github = recordedRepository();
    const target = await Effect.runPromise(
      run(resolveRepository({ ...repository, branch: "release", repositoryId: 2 }), { github }),
    );
    expect(target).toEqual({ ...resolved, branch: "release", repositoryId: 2 });
  });

  it("sends GITHUB_ACCESS_TOKEN when GITHUB_TOKEN is not set", async () => {
    const github = recordedRepository();
    await Effect.runPromise(
      run(resolveRepository(repository), { github, env: { GITHUB_ACCESS_TOKEN: "test-token" } }),
    );
    expect(github.requests[0]?.headers["authorization"]).toBe("Bearer test-token");
  });

  it("skips GitHub when the props hold both ids and the branch", async () => {
    const github = serve(() => new Response(null, { status: 500 }));
    const target = await Effect.runPromise(
      run(resolveRepository({ ...repository, ownerId: 1, repositoryId: 2 }), { github }),
    );
    expect(target).toEqual({ ...repository, ownerId: 1, repositoryId: 2 });
    expect(github.requests).toHaveLength(0);
  });

  it("names the token and the props when GitHub hides the repository", async () => {
    const github = serve(() => Response.json({ message: "Not Found" }, { status: 404 }));
    const error = await Effect.runPromise(
      Effect.flip(run(resolveRepository(repository), { github })),
    );
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error.message).toContain("GITHUB_TOKEN");
    expect(error.message).toContain("repository.repositoryId");
  });

  it("uses the current repository without repository props", async () => {
    const github = recordedRepository();
    const origin = git(
      "git@github.com:samebase-live-tests/tmp-plugin-review-9806-20260905-1434.git\n",
    );
    const target = await Effect.runPromise(
      run(resolveRepository(undefined), { github, origin: origin.spawner }),
    );
    expect(target).toEqual(resolved);
    expect(github.requests.map((request) => request.url)).toEqual([recordedUrl]);
  });
});

describe("currentRepository", () => {
  const current = {
    owner: "samebase-live-tests",
    name: "tmp-plugin-review-9806-20260905-1434",
    defaultBranch: "main",
    ownerId: 315958746,
    repositoryId: 1358278395,
  };

  it("takes GITHUB_REPOSITORY in GitHub Actions and never runs git", async () => {
    const github = recordedRepository();
    const origin = git("https://github.com/samebase/alchemy-cloudflare-workers-builds.git\n");
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "6e532269f4bd1e8e0a2a5c9e2d4f6b8a0c1e3f5a",
      GITHUB_REPOSITORY_OWNER: "samebase-live-tests",
      GITHUB_REPOSITORY: "samebase-live-tests/tmp-plugin-review-9806-20260905-1434",
    };
    const result = await Effect.runPromise(
      run(currentRepository, { github, env, origin: origin.spawner }),
    );
    expect(result).toEqual(current);
    expect(origin.commands).toHaveLength(0);
    expect(github.requests[0]?.url).toBe(recordedUrl);
  });

  it.each([
    "https://github.com/samebase-live-tests/tmp-plugin-review-9806-20260905-1434",
    "https://github.com/samebase-live-tests/tmp-plugin-review-9806-20260905-1434.git",
    "git@github.com:samebase-live-tests/tmp-plugin-review-9806-20260905-1434",
    "git@github.com:samebase-live-tests/tmp-plugin-review-9806-20260905-1434.git",
  ])("reads the owner and the name from the origin remote %s", async (url) => {
    const github = recordedRepository();
    const origin = git(`${url}\n`);
    const result = await Effect.runPromise(
      run(currentRepository, { github, origin: origin.spawner }),
    );
    expect(result).toEqual(current);
    expect(origin.commands).toMatchObject([
      { command: "git", args: ["remote", "get-url", "origin"] },
    ]);
    expect(github.requests[0]?.url).toBe(recordedUrl);
  });

  it.each([
    ["no origin remote", ""],
    ["an origin remote on another host", "git@gitlab.com:samebase-live-tests/app.git\n"],
  ])("fails with one WorkersBuildsError for %s", async (_, stdout) => {
    const github = recordedRepository();
    const origin = git(stdout);
    const error = await Effect.runPromise(
      Effect.flip(run(currentRepository, { github, origin: origin.spawner })),
    );
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error).toMatchObject({ operation: "find GitHub repository" });
    expect(error.message).not.toContain("gitlab.com");
    expect(github.requests).toHaveLength(0);
  });
});

describe("resolveBuildToken", () => {
  const api = "https://api.cloudflare.com/client/v4";
  const tokensUrl = `${api}/accounts/${accountId}/builds/tokens`;
  const listUrl = `${tokensUrl}?page=1&per_page=100`;
  const verifyUrl = `${api}/user/tokens/verify`;
  const success = (result: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result });
  const Strings = Schema.Record(Schema.String, Schema.String);
  /** The spec-derived create result, which has the same fields as a list item. */
  const registered = () =>
    Schema.decodeUnknownSync(Strings)(fixture("cloudflare/builds_tokens_create.json"));

  /**
   * Cloudflare with `tokens` as the account's build tokens, the spec-derived
   * verify response, and `created` as the create result. Records the requests.
   */
  const cloudflare = (tokens: readonly unknown[], created: unknown = registered()) =>
    serve((request) =>
      request.method === "GET" && request.url === listUrl
        ? success(tokens)
        : request.method === "GET" && request.url === verifyUrl
          ? success(fixture("cloudflare/user_tokens_verify.json"))
          : request.method === "POST" && request.url === tokensUrl
            ? success(created)
            : new Response(null, { status: 404 }),
    );
  const calls = (server: ReturnType<typeof serve>) =>
    server.requests.map((request) => `${request.method} ${request.url}`);

  const resolve = (
    server: ReturnType<typeof serve>,
    buildToken: string | undefined,
    credentials: Layer.Layer<Credentials> = fromApiToken({ apiToken: "test-token" }),
  ) =>
    resolveBuildToken(accountId, buildToken).pipe(
      Effect.provideService(HttpClient.HttpClient, server.client),
      Effect.provide(credentials),
      Effect.provideService(Stack, {
        name: "MyApp",
        stage: "dev",
        resources: {},
        bindings: {},
        actions: {},
      }),
    );

  it("takes buildToken first and calls nothing", async () => {
    const server = cloudflare([]);
    const uuid = await Effect.runPromise(
      resolve(server, legacy.production_settings.build_token_uuid),
    );
    expect(uuid).toBe("bf34959e-03df-446a-af6d-b55bff91ab8b");
    expect(server.requests).toHaveLength(0);
  });

  it("takes the account's first build token next, such as one that an earlier deploy registered", async () => {
    const server = cloudflare([registered()]);
    expect(await Effect.runPromise(resolve(server, undefined))).toBe(
      "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
    );
    expect(calls(server)).toEqual([`GET ${listUrl}`]);
  });

  it("registers the stack's API token under its verified id when the account has no build token", async () => {
    const server = cloudflare([]);
    expect(await Effect.runPromise(resolve(server, undefined))).toBe(
      "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
    );
    expect(calls(server)).toEqual([`GET ${listUrl}`, `GET ${verifyUrl}`, `POST ${tokensUrl}`]);
    const [, verify, create] = server.requests;
    expect(verify?.headers["authorization"]).toBe("Bearer test-token");
    const body = Schema.decodeUnknownSync(Strings)(
      create?.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(create.body.body))
        : undefined,
    );
    expect(Object.keys(body).sort()).toEqual([
      "build_token_name",
      "build_token_secret",
      "cloudflare_token_id",
    ]);
    const { build_token_secret: secret, ...named } = body;
    expect(named).toEqual({
      build_token_name: "alchemy-MyApp",
      cloudflare_token_id: "ed17574386854bf78a67040be0a770b0",
    });
    // Presence only, so a failure never prints the secret.
    expect(secret !== undefined && secret.length > 0).toBe(true);
  });

  it("fails with a WorkersBuildsError for OAuth credentials and registers nothing", async () => {
    const server = cloudflare([]);
    const oauth = Layer.succeed(
      Credentials,
      Effect.succeed(oauthCredentials({ accessToken: "test-oauth-token" })),
    );
    const error = await Effect.runPromise(Effect.flip(resolve(server, undefined, oauth)));
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error).toMatchObject({ operation: "register build token" });
    expect(error.message).toContain("not an API token");
    expect(error.message).toContain("pass buildToken");
    expect(error.message).not.toContain("test-oauth-token");
    expect(calls(server)).toEqual([`GET ${listUrl}`]);
  });

  it("fails when the create result has no build_token_uuid", async () => {
    const { build_token_uuid: _, ...withoutUuid } = registered();
    const error = await Effect.runPromise(
      Effect.flip(resolve(cloudflare([], withoutUuid), undefined)),
    );
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error.message).toContain("no build_token_uuid");
  });
});
