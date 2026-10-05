// WorkersBuilds.Repository through the real Alchemy engine over the fake API
// in engine.ts: the requests that a deploy sends, and the configuration that
// Workers Builds holds after it.
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import * as WorkersBuilds from "../src/index.ts";
import {
  type Builds,
  engine,
  type FakeApi,
  fakeApi,
  type GitHubRepository,
  recordedRepository,
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
    expect(api.requests.filter((request) => !request.includes("api.github.com"))).toEqual([
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
  it("creates the configuration of the new Worker, then deletes the old one", async () => {
    const api = github();
    const deploy = engine(api);
    const moved = "eaeec9c35fa64976a823c246164f4204";
    await deploy.deploy(stack(byName(recorded)));
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
