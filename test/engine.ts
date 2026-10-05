// The real Alchemy engine (plan, apply, and drift) over a fake Cloudflare and
// GitHub API, for unit tests of the resource lifecycles. The fake keeps the
// Workers Builds configurations, the build triggers, and the Workers in memory
// and records every request. It answers in the shapes of the recorded payloads
// in test/fixtures/: each configuration starts from
// cloudflare/builds_workers_get_native.json, each Worker from
// cloudflare/workers_workers_get.json, and each GitHub repository from
// github/repos_get.json.
import { readFileSync } from "node:fs";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import { ProfileStore } from "alchemy/Auth/Profile";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import * as Drift from "alchemy/Drift";
import * as Interaction from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { make as makeStack, Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
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
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Providers } from "../src/Providers.ts";
import { Repository, RepositoryProvider } from "../src/Repository.ts";
import { Secret, SecretProvider } from "../src/Secret.ts";
import { Worker, WorkerProvider } from "../src/Worker.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

export const accountId = "fe57d01d7ab41f60d00ba1aade20eb33";
const api = `/client/v4/accounts/${accountId}`;

const Variable = Schema.Struct({
  is_secret: Schema.Boolean,
  created_on: Schema.String,
  value: Schema.NullOr(Schema.String),
});
const Settings = Schema.Struct({
  build_command: Schema.String,
  deploy_command: Schema.String,
  root_directory: Schema.String,
  build_caching_enabled: Schema.Boolean,
  path_includes: Schema.Array(Schema.String),
  path_excludes: Schema.Array(Schema.String),
  build_token_uuid: Schema.String,
  environment_variables: Schema.Record(Schema.String, Variable),
});
/** A Workers Builds configuration in the shape of the recorded GET result. */
const Builds = Schema.Struct({
  script_tag: Schema.String,
  git_repository: Schema.Struct({
    repo_id: Schema.String,
    repo_name: Schema.String,
    provider_type: Schema.String,
    provider_account_id: Schema.String,
    provider_account_name: Schema.String,
    grant_id: Schema.Null,
    branch: Schema.String,
  }),
  production_settings: Settings,
  previews_enabled: Schema.Boolean,
  previews_base_config: Settings,
});
export type Builds = typeof Builds.Type;
export type BuildSettings = typeof Settings.Type;

/** The request body that the provider sends for one variable: `null` removes it. */
const VariableInput = Schema.NullOr(
  Schema.Struct({ value: Schema.String, is_secret: Schema.Boolean }),
);
const SettingsInput = Schema.Struct({
  build_command: Schema.String,
  deploy_command: Schema.String,
  root_directory: Schema.String,
  build_caching_enabled: Schema.Boolean,
  path_includes: Schema.Array(Schema.String),
  path_excludes: Schema.Array(Schema.String),
  build_token_uuid: Schema.String,
  environment_variables: Schema.Record(Schema.String, VariableInput),
});
const CreateInput = Schema.Struct({
  script_tag: Schema.String,
  git_repository: Schema.Struct({
    provider_type: Schema.String,
    provider_account_id: Schema.String,
    provider_account_name: Schema.String,
    repo_id: Schema.String,
    repo_name: Schema.String,
    branch: Schema.String,
  }),
  production_settings: SettingsInput,
  previews_base_config: SettingsInput,
  previews_enabled: Schema.Boolean,
});
const UpdateInput = Schema.Struct({
  git_repository: Schema.Struct({ branch: Schema.String }),
  production_settings: SettingsInput,
  previews_base_config: SettingsInput,
  previews_enabled: Schema.Boolean,
});

/** A trigger as the distilled `listTriggers` reads it. */
export interface Trigger {
  readonly trigger_uuid: string;
  readonly external_script_id: string;
  readonly deleted_on: null;
  readonly repo_connection: { readonly repo_connection_uuid: string; readonly repo_id: string };
}

const Observability = Schema.Record(Schema.String, Schema.Unknown);
/** A Worker in the shape of the schema-derived GET result. */
const StoredWorker = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created_on: Schema.String,
  updated_on: Schema.String,
  logpush: Schema.Boolean,
  observability: Observability,
  references: Schema.Record(Schema.String, Schema.Unknown),
  subdomain: Schema.Record(Schema.String, Schema.Unknown),
  tags: Schema.Array(Schema.String),
  tail_consumers: Schema.Array(Schema.Struct({ name: Schema.String })),
});
export type StoredWorker = typeof StoredWorker.Type;
const WorkerInput = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  logpush: Schema.optionalKey(Schema.Boolean),
  observability: Schema.optionalKey(Observability),
  subdomain: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  tail_consumers: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
});

const GitHubRepository = Schema.Struct({
  default_branch: Schema.String,
  full_name: Schema.String,
  id: Schema.Number,
  name: Schema.String,
  node_id: Schema.String,
  owner: Schema.Struct({ id: Schema.Number, login: Schema.String, type: Schema.String }),
  private: Schema.Boolean,
});
export type GitHubRepository = typeof GitHubRepository.Type;

/** The recorded GitHub repository, which the recorded Builds configurations build from. */
export const recordedRepository = () =>
  Schema.decodeUnknownSync(GitHubRepository)(fixture("github/repos_get.json"));

const recordedBuilds = () =>
  Schema.decodeUnknownSync(Builds)(fixture("cloudflare/builds_workers_get_native.json"));

const recordedWorker = () =>
  Schema.decodeUnknownSync(StoredWorker)(fixture("cloudflare/workers_workers_get.json"));

const missingConfiguration = () => fixture("cloudflare/builds_workers_get_missing_error.json");
const missingWorker = () => fixture("cloudflare/workers_scripts_not_found_error.json");

const success = (result: unknown) =>
  Response.json({ success: true, errors: [], messages: [], result });

/** The JSON body of a request. */
const jsonBody = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;

/** Applies the variables of a request: `null` removes one, a secret keeps no value. */
const applyVariables = (
  stored: BuildSettings["environment_variables"],
  input: (typeof SettingsInput.Type)["environment_variables"],
  createdOn: string,
) => {
  const next = { ...stored };
  for (const [key, value] of Object.entries(input)) {
    if (value === null) delete next[key];
    else
      next[key] = {
        is_secret: value.is_secret,
        created_on: createdOn,
        value: value.is_secret ? null : value.value,
      };
  }
  return next;
};

const applySettings = (stored: BuildSettings, input: typeof SettingsInput.Type): BuildSettings => ({
  ...stored,
  build_command: input.build_command,
  deploy_command: input.deploy_command,
  root_directory: input.root_directory,
  build_caching_enabled: input.build_caching_enabled,
  path_includes: input.path_includes,
  path_excludes: input.path_excludes,
  build_token_uuid: input.build_token_uuid,
  environment_variables: applyVariables(
    stored.environment_variables,
    input.environment_variables,
    "2026-10-06T00:00:00.000Z",
  ),
});

/**
 * A fake Cloudflare API and GitHub API. `requests` records each call as
 * `METHOD path`, with the path after `/client/v4/accounts/<account id>` for
 * Cloudflare and the full URL for GitHub.
 */
export const fakeApi = () => {
  const requests: string[] = [];
  const configurations = new Map<string, Builds>();
  const triggers = new Map<string, readonly Trigger[]>();
  const workers = new Map<string, StoredWorker>();
  const repositories = new Map<string, GitHubRepository>();
  let sequence = 0;

  const addRepository = (repository: GitHubRepository) => {
    repositories.set(repository.full_name.toLowerCase(), repository);
  };

  const createTriggers = (scriptTag: string, repoId: string) => {
    sequence += 1;
    const suffix = String(sequence).padStart(12, "0");
    triggers.set(scriptTag, [
      {
        trigger_uuid: `b595a215-7b9b-4a04-a55d-${suffix}`,
        external_script_id: scriptTag,
        deleted_on: null,
        repo_connection: { repo_connection_uuid: `connection-${repoId}`, repo_id: repoId },
      },
    ]);
  };

  const builds = (method: string, path: string, request: HttpClientRequest.HttpClientRequest) => {
    const created = /^\/builds\/workers$/.exec(path);
    if (created && method === "POST") {
      const input = Schema.decodeUnknownSync(CreateInput)(jsonBody(request));
      // One configuration per Worker, as in Workers Builds.
      if (configurations.has(input.script_tag)) {
        return Response.json(
          {
            success: false,
            errors: [{ code: 12001, message: "Worker already has a build configuration" }],
            messages: [],
            result: null,
          },
          { status: 400 },
        );
      }
      const template = recordedBuilds();
      const next: Builds = {
        script_tag: input.script_tag,
        git_repository: { ...input.git_repository, grant_id: null },
        production_settings: applySettings(
          { ...template.production_settings, environment_variables: {} },
          input.production_settings,
        ),
        previews_enabled: input.previews_enabled,
        previews_base_config: applySettings(
          { ...template.previews_base_config, environment_variables: {} },
          input.previews_base_config,
        ),
      };
      configurations.set(input.script_tag, next);
      createTriggers(input.script_tag, input.git_repository.repo_id);
      return success(next);
    }
    const tagged = /^\/builds\/workers\/([^/]+)(\/[a-z_]+)?$/.exec(path);
    if (tagged) {
      const scriptTag = tagged[1] ?? "";
      const action = tagged[2];
      const current = configurations.get(scriptTag);
      if (action === "/triggers" && method === "GET") return success(triggers.get(scriptTag) ?? []);
      if (current === undefined) return Response.json(missingConfiguration(), { status: 404 });
      if (action === undefined && method === "GET") return success(current);
      if (action === undefined && method === "DELETE") {
        configurations.delete(scriptTag);
        return success(null);
      }
      if (action === undefined && method === "PATCH") {
        const input = Schema.decodeUnknownSync(UpdateInput)(jsonBody(request));
        const next: Builds = {
          ...current,
          git_repository: { ...current.git_repository, branch: input.git_repository.branch },
          production_settings: applySettings(
            current.production_settings,
            input.production_settings,
          ),
          previews_enabled: input.previews_enabled,
          previews_base_config: applySettings(
            current.previews_base_config,
            input.previews_base_config,
          ),
        };
        configurations.set(scriptTag, next);
        return success(next);
      }
      if (action === "/migrate_to_previews" && method === "POST") {
        const next = { ...current, previews_enabled: true };
        configurations.set(scriptTag, next);
        return success(next);
      }
    }
    const trigger = /^\/builds\/triggers\/([^/]+)$/.exec(path);
    if (trigger && method === "DELETE") {
      for (const [scriptTag, list] of triggers) {
        triggers.set(
          scriptTag,
          list.filter((item) => item.trigger_uuid !== trigger[1]),
        );
      }
      return success(null);
    }
    return undefined;
  };

  const workerApi = (
    method: string,
    path: string,
    request: HttpClientRequest.HttpClientRequest,
  ) => {
    if (path === "/workers/subdomain" && method === "GET") return success({ subdomain: "rir" });
    if (path === "/workers/workers" && method === "POST") {
      const input = Schema.decodeUnknownSync(WorkerInput)(jsonBody(request));
      sequence += 1;
      const id = `eaeec9c35fa64976a823c2461642${String(sequence).padStart(4, "0")}`;
      const next: StoredWorker = { ...recordedWorker(), ...input, id, name: input.name ?? id };
      workers.set(id, next);
      return success(next);
    }
    const named = /^\/workers\/workers\/([^/]+)$/.exec(path);
    if (named) {
      const key = named[1] ?? "";
      const current =
        workers.get(key) ?? [...workers.values()].find((worker) => worker.name === key);
      if (current === undefined) return Response.json(missingWorker(), { status: 404 });
      if (method === "GET") return success(current);
      if (method === "PATCH") {
        const input = Schema.decodeUnknownSync(WorkerInput)(jsonBody(request));
        const next: StoredWorker = { ...current, ...input };
        workers.set(current.id, next);
        return success(next);
      }
      if (method === "DELETE") {
        workers.delete(current.id);
        return success(null);
      }
    }
    return undefined;
  };

  const respond = (request: HttpClientRequest.HttpClientRequest): Response => {
    const url = new URL(request.url);
    if (url.host === "api.github.com") {
      requests.push(`${request.method} ${request.url}`);
      const [, , owner, name] = url.pathname.split("/");
      const repository = repositories.get(`${owner}/${name}`.toLowerCase());
      return repository === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(repository);
    }
    const path = url.pathname.startsWith(api) ? url.pathname.slice(api.length) : url.pathname;
    requests.push(`${request.method} ${path}`);
    return (
      builds(request.method, path, request) ??
      workerApi(request.method, path, request) ??
      Response.json(
        {
          success: false,
          errors: [{ code: 7003, message: "No route" }],
          messages: [],
          result: null,
        },
        { status: 404 },
      )
    );
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
  );

  return { requests, configurations, triggers, workers, repositories, addRepository, client };
};
export type FakeApi = ReturnType<typeof fakeApi>;

/** A git that prints `stdout()` for every command, such as the `origin` remote. */
const git = (stdout: () => string) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout())),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    ),
  );

/** The package's providers with fixed test credentials instead of Alchemy's login. */
const providers = Layer.effect(Providers, Provider.collection([Worker, Repository, Secret])).pipe(
  Layer.provide(Layer.mergeAll(WorkerProvider(), RepositoryProvider(), SecretProvider())),
  Layer.provideMerge(
    Layer.mergeAll(
      fromApiToken({ apiToken: "test-token" }),
      Layer.succeed(
        CloudflareEnvironment,
        Effect.succeed({
          type: "apiToken" as const,
          apiToken: Redacted.make("test-token"),
          accountId,
          source: { type: "env" as const },
        }),
      ),
    ),
  ),
);

const STACK = "Test";
const STAGE = "test";

/**
 * One stack with its own in-memory state over `api`. `deploy` plans and
 * applies a stack program, `plan` only plans it, and `drift` runs Alchemy's
 * drift check (as `alchemy drift` and `alchemy deploy --detect-drift` do) on
 * the saved state. `remote.origin` is the `origin` remote that git prints;
 * a test can change it between deploys.
 */
export const engine = (api: FakeApi, remote: { origin: string } = { origin: "" }) => {
  const state = Layer.succeed(State.State, State.InMemoryService({}));

  /** The services that the CLI gives a deploy, with the fake API and git. */
  const services = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, api.client),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      git(() => remote.origin),
    ),
    Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    Layer.succeed(AdoptPolicy, false),
    Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
    Layer.succeed(AuthProviders, {}),
    Interaction.layerNonInteractive(),
    Layer.succeed(Stage, STAGE),
    state,
    NodeCrypto.layer,
    NodeFileSystem.layer,
    NodePath.layer,
    // The stack type asks for the profile and credential stores, which read
    // the user's Alchemy login. The tests use fixed credentials, and a mock
    // fails loudly when something calls one.
    Layer.mock(ProfileStore, {}),
    Layer.mock(CredentialsStore, {}),
  );

  /** The context of a drift check: the state, the providers, and the stack. */
  const stored = state.pipe(
    Layer.provideMerge(providers),
    Layer.provideMerge(
      Layer.succeed(Stack, { name: STACK, stage: STAGE, resources: {}, bindings: {}, actions: {} }),
    ),
  );

  const compile = <A>(program: Effect.Effect<A, never, Providers>) =>
    program.pipe(makeStack({ name: STACK, providers, state }));

  return {
    deploy: <A>(program: Effect.Effect<A, never, Providers>) =>
      Effect.runPromise(
        compile(program).pipe(
          Effect.flatMap((compiled) =>
            Plan.make(compiled, {}).pipe(Effect.flatMap(apply), Effect.provide(compiled.services)),
          ),
          provideFreshArtifactStore,
          Effect.scoped,
          Effect.provide(services),
        ),
      ),
    plan: <A>(program: Effect.Effect<A, never, Providers>) =>
      Effect.runPromise(
        compile(program).pipe(
          Effect.flatMap((compiled) =>
            Plan.make(compiled, {}).pipe(Effect.provide(compiled.services)),
          ),
          provideFreshArtifactStore,
          Effect.scoped,
          Effect.provide(services),
        ),
      ),
    drift: () =>
      Effect.runPromise(
        Drift.plan({ name: STACK, stage: STAGE }).pipe(
          Effect.provide(stored),
          provideFreshArtifactStore,
          Effect.provide(services),
        ),
      ),
    /** The saved attributes of a resource. */
    attributes: (fqn: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* yield* State.State;
          const saved = yield* store.get({ stack: STACK, stage: STAGE, fqn });
          return State.isResourceState(saved) ? saved.attr : undefined;
        }).pipe(Effect.provide(state)),
      ),
  };
};
