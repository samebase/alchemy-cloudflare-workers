// WorkersBuilds.Repository through the real Alchemy engine over the fake API
// in engine.ts: the requests that a deploy sends, and the configuration that
// Workers Builds holds after it.
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import * as WorkersBuilds from "../src/index.ts";
import {
  type Builds,
  engine,
  type FakeApi,
  fakeApi,
  type GitHubRepository,
  recordedRepository,
  registeredBuildToken,
} from "./engine.ts";

const scriptTag = "3717c592bb564236a6815df01f084963";
const buildToken = "bf34959e-03df-446a-af6d-b55bff91ab8b";

const recorded = recordedRepository();
const owner = recorded.owner.login;
/** The recorded repository after a rename on GitHub: the same id under another name. */
const renamed: GitHubRepository = {
  ...recorded,
  name: "tmp-plugin-review-renamed",
  full_name: `${owner}/tmp-plugin-review-renamed`,
};
/** Another repository: the id and name of the one in builds_workers_create.json. */
const other: GitHubRepository = {
  ...recorded,
  id: 1397342994,
  name: "tmp-native-preview-template-native-previews",
  full_name: `${owner}/tmp-native-preview-template-native-previews`,
};

/** The API with the three repositories on GitHub. */
const github = () => {
  const api = fakeApi();
  for (const repository of [recorded, renamed, other]) api.addRepository(repository);
  return api;
};

/** The repository prop by name only, as an app passes it. */
const byName = (repository: GitHubRepository) => ({ owner, name: repository.name, branch: "main" });
/** The repository prop with the GitHub ids. */
const withIds = (repository: GitHubRepository) => ({
  ...byName(repository),
  ownerId: repository.owner.id,
  repositoryId: repository.id,
});

/** The attributes as 0.4 saved them: no repository and no settings. */
const before05 = Schema.decodeUnknownSync(
  Schema.Struct({
    scriptTag: Schema.String,
    repoConnectionId: Schema.optionalKey(Schema.String),
    triggerIds: Schema.Array(Schema.String),
    previewsEnabled: Schema.Boolean,
    accountId: Schema.String,
  }),
);

/** A stack with one Builds configuration for `worker`. */
const stack = (repository: WorkersBuilds.GitHubRepository | undefined, worker = scriptTag) =>
  Effect.gen(function* () {
    const builds = yield* WorkersBuilds.Repository("Builds", {
      worker,
      ...(repository === undefined ? {} : { repository }),
      buildCommand: "pnpm run build",
      buildToken,
    });
    return { scriptTag: builds.scriptTag, triggerIds: builds.triggerIds };
  });

describe("a renamed repository", () => {
  it.each([
    ["without ids in the old or the new props", byName(recorded), byName(renamed)],
    ["with ids in the old props only", withIds(recorded), byName(renamed)],
    ["with ids in the new props only", byName(recorded), withIds(renamed)],
  ])("updates the same configuration %s: GET, PATCH, no DELETE", async (_, before, after) => {
    const api = github();
    const deploy = engine(api);
    const first = await deploy.deploy(stack(before));
    const plan = await deploy.plan(stack(after));
    expect(plan.resources["Builds"]?.action).toBe("update");
    api.requests.length = 0;

    const second = await deploy.deploy(stack(after));

    expect(second.scriptTag).toBe(first.scriptTag);
    expect(second.triggerIds).toEqual(first.triggerIds);
    // The plan reads the configuration, then the apply reads, patches, and reads it again.
    expect(api.requests.filter((request) => !request.includes("api.github.com"))).toEqual([
      `GET /builds/workers/${scriptTag}`,
      `GET /builds/workers/${scriptTag}`,
      `PATCH /builds/workers/${scriptTag}`,
      `GET /builds/workers/${scriptTag}`,
      `GET /builds/workers/${scriptTag}/triggers`,
    ]);
    expect(api.configurations.get(scriptTag)?.git_repository.repo_id).toBe(String(recorded.id));
    expect(await deploy.attributes("Builds")).toMatchObject({
      repository: { repositoryId: recorded.id, ownerId: recorded.owner.id, branch: "main" },
    });
  });
});

describe("another repository for the same Worker", () => {
  it("deletes the old triggers and configuration, then creates the new one, in one deploy", async () => {
    const api = github();
    const deploy = engine(api);
    const first = await deploy.deploy(stack(byName(recorded)));
    api.requests.length = 0;

    const second = await deploy.deploy(stack(byName(other)));

    expect(api.requests.filter((request) => !request.includes("api.github.com"))).toEqual([
      `GET /builds/workers/${scriptTag}`,
      `GET /builds/workers/${scriptTag}`,
      `GET /builds/workers/${scriptTag}/triggers`,
      `DELETE /builds/triggers/${first.triggerIds[0]}`,
      `DELETE /builds/workers/${scriptTag}`,
      "POST /builds/workers",
      `PATCH /builds/workers/${scriptTag}`,
      `GET /builds/workers/${scriptTag}`,
      `GET /builds/workers/${scriptTag}/triggers`,
    ]);
    // The Worker ends with one configuration, for the new repository, and
    // only its triggers.
    const configuration = api.configurations.get(scriptTag);
    expect(configuration?.git_repository).toMatchObject({
      repo_id: String(other.id),
      repo_name: other.name,
    });
    expect(configuration?.production_settings.build_token_uuid).toBe(buildToken);
    const triggers = (api.triggers.get(scriptTag) ?? []).map((trigger) => trigger.trigger_uuid);
    expect(triggers).toEqual(second.triggerIds);
    expect(triggers).not.toContain(first.triggerIds[0]);
    expect(second.scriptTag).toBe(scriptTag);
  });

  it("fails without a change when only the repository of the run changed", async () => {
    const api = github();
    const remote = { origin: `git@github.com:${owner}/${recorded.name}.git\n` };
    const deploy = engine(api, remote);
    await deploy.deploy(stack(undefined));
    const before = api.configurations.get(scriptTag);
    api.requests.length = 0;

    // A clone of another repository, such as a fork, with the same state.
    remote.origin = `git@github.com:${owner}/${other.name}.git\n`;
    const error = await deploy.deploy(stack(undefined)).then(
      () => undefined,
      (failure: unknown) => String(failure),
    );

    expect(error).toContain("pass repository");
    expect(api.configurations.get(scriptTag)).toEqual(before);
    expect(api.requests.some((request) => request.startsWith("DELETE"))).toBe(false);
  });
});

describe("another Worker", () => {
  const moved = "eaeec9c35fa64976a823c246164f4204";

  it("replaces: creates the configuration of the new Worker, then deletes the old one", async () => {
    const api = github();
    const deploy = engine(api);
    await deploy.deploy(stack(byName(recorded)));
    expect((await deploy.plan(stack(byName(recorded), moved))).resources["Builds"]?.action).toBe(
      "replace",
    );
    api.requests.length = 0;

    const second = await deploy.deploy(stack(byName(recorded), moved));

    expect(second.scriptTag).toBe(moved);
    expect([...api.configurations.keys()]).toEqual([moved]);
    const created = api.requests.indexOf("POST /builds/workers");
    const deleted = api.requests.indexOf(`DELETE /builds/workers/${scriptTag}`);
    expect(created).toBeGreaterThan(-1);
    expect(deleted).toBeGreaterThan(created);
    expect(api.triggers.get(scriptTag)).toEqual([]);
  });

  it("keeps the old configuration when the resource is retained", async () => {
    const api = github();
    const deploy = engine(api);
    const retained = (worker: string) =>
      stack(byName(recorded), worker).pipe(RemovalPolicy.retain());
    await deploy.deploy(retained(scriptTag));

    await deploy.deploy(retained(moved));

    expect([...api.configurations.keys()].sort()).toEqual([scriptTag, moved].sort());
    expect(api.requests.some((request) => request.startsWith("DELETE"))).toBe(false);
  });

  it("updates, and never deletes the new configuration, when the same deploy replaces the Worker", async () => {
    const api = github();
    const deploy = engine(api);
    const program = (name: string) =>
      Effect.gen(function* () {
        const worker = yield* WorkersBuilds.Worker("Worker", { name });
        const builds = yield* WorkersBuilds.Repository("Builds", {
          worker: worker.workerId,
          repository: byName(recorded),
          buildCommand: "pnpm run build",
          buildToken,
        });
        return { workerId: worker.workerId, scriptTag: builds.scriptTag };
      });
    const first = await deploy.deploy(program("old-app"));
    // The plan cannot know the tag of the new Worker, so it is no replacement.
    expect((await deploy.plan(program("new-app"))).resources["Builds"]?.action).toBe("update");

    const second = await deploy.deploy(program("new-app"));

    expect(second.workerId).not.toBe(first.workerId);
    expect(second.scriptTag).toBe(second.workerId);
    expect(api.configurations.get(second.workerId)?.git_repository.repo_id).toBe(
      String(recorded.id),
    );
    expect(api.requests).not.toContain(`DELETE /builds/workers/${second.workerId}`);
    // Alchemy deleted the old Worker; the provider left its configuration.
    expect(api.workers.has(first.workerId)).toBe(false);
  });
});

describe("a failed create after the old configuration was deleted", () => {
  it("keeps the saved build token when the next deploy creates the configuration", async () => {
    const api = github();
    const saved = registeredBuildToken();
    api.buildTokens.push(saved);
    const deploy = engine(api);
    const unpinned = (repository: WorkersBuilds.GitHubRepository) =>
      Effect.gen(function* () {
        const builds = yield* WorkersBuilds.Repository("Builds", {
          worker: scriptTag,
          repository,
          buildCommand: "pnpm run build",
        });
        return { scriptTag: builds.scriptTag };
      });
    await deploy.deploy(unpinned(byName(recorded)));
    expect(api.configurations.get(scriptTag)?.production_settings.build_token_uuid).toBe(
      saved.build_token_uuid,
    );
    // A newer build token, which the account picks first for a new configuration.
    api.buildTokens.push({
      ...saved,
      build_token_name: "zz-newer",
      build_token_uuid: "37ba157d-9fb1-4cf9-8382-4d9fe7d69816",
    });

    api.failures.add("POST /builds/workers");
    const failed = await deploy.deploy(unpinned(byName(other))).then(
      () => undefined,
      (failure: unknown) => String(failure),
    );
    expect(failed).toContain("Injected failure");
    expect(api.configurations.has(scriptTag)).toBe(false);

    await deploy.deploy(unpinned(byName(other)));
    const configuration = api.configurations.get(scriptTag);
    expect(configuration?.git_repository.repo_id).toBe(String(other.id));
    expect(configuration?.production_settings.build_token_uuid).toBe(saved.build_token_uuid);
  });
});

describe("a configuration that is gone", () => {
  it("is created again by the next deploy after a repair deleted it and failed to create it", async () => {
    const api = github();
    const deploy = engine(api);
    const program = stack(byName(recorded));
    await deploy.deploy(program);
    // The dashboard connects the Worker to another repository.
    const current = api.configurations.get(scriptTag);
    if (current === undefined) throw new Error("no configuration");
    api.configurations.set(scriptTag, {
      ...current,
      git_repository: {
        ...current.git_repository,
        repo_id: String(other.id),
        repo_name: other.name,
      },
    });

    api.failures.add("POST /builds/workers");
    const repair = await deploy.repair().then(
      () => undefined,
      (failure: unknown) => String(failure),
    );
    expect(repair).toBeDefined();
    expect(api.configurations.has(scriptTag)).toBe(false);

    expect((await deploy.plan(program)).resources["Builds"]?.action).toBe("update");
    await deploy.deploy(program);
    const configuration = api.configurations.get(scriptTag);
    expect(configuration?.git_repository.repo_id).toBe(String(recorded.id));
    expect(configuration?.production_settings.build_token_uuid).toBe(buildToken);
  });
});

describe("a repair that failed halfway", () => {
  /** A deployed configuration that the dashboard then connected to another repository. */
  const reconnected = async <A>(
    api: FakeApi,
    deploy: ReturnType<typeof engine>,
    program: Effect.Effect<A, never, WorkersBuilds.Providers>,
  ) => {
    await deploy.deploy(program);
    const current = api.configurations.get(scriptTag);
    if (current === undefined) throw new Error("no configuration");
    api.configurations.set(scriptTag, {
      ...current,
      git_repository: {
        ...current.git_repository,
        repo_id: String(other.id),
        repo_name: other.name,
      },
    });
  };

  it("is completed by the next deploy when the delete of the configuration failed", async () => {
    const api = github();
    const deploy = engine(api);
    const program = stack(byName(recorded));
    await reconnected(api, deploy, program);

    // The repair deletes the triggers, and then the delete of the configuration fails.
    api.failures.add(`DELETE /builds/workers/${scriptTag}`);
    expect(await deploy.repair().then(() => "repaired", String)).not.toBe("repaired");
    expect(api.triggers.get(scriptTag)).toEqual([]);
    expect(api.configurations.has(scriptTag)).toBe(true);

    expect((await deploy.plan(program)).resources["Builds"]?.action).toBe("update");
    await deploy.deploy(program);
    expect(api.configurations.get(scriptTag)?.git_repository.repo_id).toBe(String(recorded.id));
    expect(api.triggers.get(scriptTag)).toHaveLength(1);
  });

  it("does not pick another account token for state from 0.4", async () => {
    const api = github();
    const saved = registeredBuildToken();
    api.buildTokens.push(saved);
    const deploy = engine(api);
    const unpinned = (token?: string) =>
      Effect.gen(function* () {
        const builds = yield* WorkersBuilds.Repository("Builds", {
          worker: scriptTag,
          repository: byName(recorded),
          buildCommand: "pnpm run build",
          ...(token === undefined ? {} : { buildToken: token }),
        });
        return { scriptTag: builds.scriptTag };
      });
    await reconnected(api, deploy, unpinned());
    await deploy.editAttributes("Builds", before05);
    api.buildTokens.push({
      ...saved,
      build_token_name: "zz-newer",
      build_token_uuid: "37ba157d-9fb1-4cf9-8382-4d9fe7d69816",
    });

    // The repair deletes the configuration, and then the create fails.
    api.failures.add("POST /builds/workers");
    expect(await deploy.repair().then(() => "repaired", String)).not.toBe("repaired");
    expect(api.configurations.has(scriptTag)).toBe(false);

    const failed = await deploy.deploy(unpinned()).then(() => undefined, String);
    expect(failed).toContain("Pass buildToken");
    expect(api.configurations.has(scriptTag)).toBe(false);

    await deploy.deploy(unpinned(saved.build_token_uuid));
    expect(api.configurations.get(scriptTag)?.production_settings.build_token_uuid).toBe(
      saved.build_token_uuid,
    );
  });
});

describe("a configuration that is gone, with the repository of the run", () => {
  it("is created again only for the repository that the state saved", async () => {
    const api = github();
    const remote = { origin: `git@github.com:${owner}/${recorded.name}.git\n` };
    const deploy = engine(api, remote);
    await deploy.deploy(stack(undefined));
    // Someone deletes the configuration in the dashboard.
    api.configurations.delete(scriptTag);
    api.requests.length = 0;

    remote.origin = `git@github.com:${owner}/${other.name}.git\n`;
    const failed = await deploy.deploy(stack(undefined)).then(() => undefined, String);
    expect(failed).toContain("pass repository");
    expect(api.requests).not.toContain("POST /builds/workers");

    remote.origin = `git@github.com:${owner}/${recorded.name}.git\n`;
    await deploy.deploy(stack(undefined));
    expect(api.configurations.get(scriptTag)?.git_repository.repo_id).toBe(String(recorded.id));
  });
});

describe("state from 0.4", () => {
  it("moves to another repository only with buildToken, because it has no saved token", async () => {
    const api = github();
    api.buildTokens.push(registeredBuildToken());
    const deploy = engine(api);
    const unpinned = (repository: WorkersBuilds.GitHubRepository, token?: string) =>
      Effect.gen(function* () {
        const builds = yield* WorkersBuilds.Repository("Builds", {
          worker: scriptTag,
          repository,
          buildCommand: "pnpm run build",
          ...(token === undefined ? {} : { buildToken: token }),
        });
        return { scriptTag: builds.scriptTag };
      });
    await deploy.deploy(unpinned(byName(recorded)));
    await deploy.editAttributes("Builds", before05);
    const before = api.configurations.get(scriptTag);

    const failed = await deploy.deploy(unpinned(byName(other))).then(
      () => undefined,
      (failure: unknown) => String(failure),
    );
    expect(failed).toContain("pass buildToken");
    expect(api.configurations.get(scriptTag)).toEqual(before);

    await deploy.deploy(unpinned(byName(other), registeredBuildToken().build_token_uuid));
    expect(api.configurations.get(scriptTag)?.git_repository.repo_id).toBe(String(other.id));
  });
});

describe("drift", () => {
  /** A deployed configuration with a plain and a secret variable and a path filter. */
  const deployed = async () => {
    const api = github();
    const deploy = engine(api);
    const program = Effect.gen(function* () {
      const builds = yield* WorkersBuilds.Repository("Builds", {
        worker: scriptTag,
        repository: withIds(recorded),
        buildCommand: "pnpm run build",
        buildToken,
        pathExcludes: ["*.md"],
        variables: { GREETING: "hello", CONVEX_DEPLOY_KEY: Redacted.make("test-deploy-key") },
      });
      return { scriptTag: builds.scriptTag };
    });
    await deploy.deploy(program);
    return { api, deploy, program };
  };

  /** Changes the configuration as the Cloudflare dashboard would. */
  const edit = (api: FakeApi, change: (builds: Builds) => Builds) => {
    const current = api.configurations.get(scriptTag);
    if (current === undefined) throw new Error("no configuration");
    api.configurations.set(scriptTag, change(current));
  };

  it("sees no drift and plans no change right after a deploy", async () => {
    const { api, deploy, program } = await deployed();
    api.requests.length = 0;
    const drift = await deploy.drift();
    expect(drift.result.resources["Builds"]?.action).toBe("unchanged");
    expect((await deploy.plan(program)).resources["Builds"]?.action).toBe("noop");
    expect(api.requests.filter((request) => !request.startsWith("GET"))).toEqual([]);
  });

  it.each([
    [
      "a changed build command",
      (builds: Builds): Builds => ({
        ...builds,
        production_settings: { ...builds.production_settings, build_command: "npm run build" },
      }),
    ],
    [
      "a changed path filter",
      (builds: Builds): Builds => ({
        ...builds,
        previews_base_config: { ...builds.previews_base_config, path_excludes: [] },
      }),
    ],
    [
      "a removed variable",
      (builds: Builds): Builds => {
        const { GREETING: _, ...variables } = builds.production_settings.environment_variables;
        return {
          ...builds,
          production_settings: { ...builds.production_settings, environment_variables: variables },
        };
      },
    ],
  ])("plans an update for %s, and the repair restores it", async (_, change) => {
    const { api, deploy } = await deployed();
    const before = api.configurations.get(scriptTag);
    edit(api, change);

    const drift = await deploy.drift();
    expect(drift.result.resources["Builds"]?.action).toBe("drifted");
    expect(drift.plan.resources["Builds"]?.action).toBe("update");

    await deploy.repair();
    const repaired = api.configurations.get(scriptTag);
    expect(repaired?.production_settings.build_command).toBe(
      before?.production_settings.build_command,
    );
    expect(repaired?.previews_base_config.path_excludes).toEqual(["*.md"]);
    expect(Object.keys(repaired?.production_settings.environment_variables ?? {}).sort()).toEqual([
      "CONVEX_DEPLOY_KEY",
      "GREETING",
    ]);
    expect((await deploy.drift()).result.resources["Builds"]?.action).toBe("unchanged");
  });

  it("does not see a changed variable value, which the attributes never hold", async () => {
    const { api, deploy } = await deployed();
    edit(api, (builds) => ({
      ...builds,
      production_settings: {
        ...builds.production_settings,
        environment_variables: {
          ...builds.production_settings.environment_variables,
          GREETING: { is_secret: false, created_on: "2026-10-06T00:00:00.000Z", value: "changed" },
        },
      },
    }));
    expect((await deploy.drift()).result.resources["Builds"]?.action).toBe("unchanged");
    expect(JSON.stringify(await deploy.attributes("Builds"))).not.toContain("hello");
  });
});
