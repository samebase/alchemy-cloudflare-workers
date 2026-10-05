// WorkersBuilds.Repository: the Workers Builds configuration of one Worker.
//
// It links a GitHub repository to the Worker, sets the production trigger
// and the Worker Previews settings, and writes the build variables. Builds
// then runs the deploy command on each push to the production branch and the
// preview deploy command on every other branch. This resource never deletes
// the Worker.
//
// The diff of this resource never replaces it. Workers Builds keeps one
// configuration per Worker, and Alchemy creates a replacement before it
// deletes the old resource. So a replacement for the same Worker would update
// the configuration and then delete it. Reconcile changes the one
// configuration in place instead, also for another repository or Worker.
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as user from "@distilled.cloud/cloudflare/user";
import * as workersBuilds from "@distilled.cloud/cloudflare/workers_builds";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { Artifacts } from "alchemy/Artifacts";
import { havePropsChanged, isResolved, type UpdateDiff } from "alchemy/Diff";
import { GitHubEnv } from "alchemy/GitHub";
import * as Provider from "alchemy/Provider";
import { StackName } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import {
  absentAsUndefined,
  cloudflareRequest,
  currentAccountId,
  isNotFound,
  refused,
  WorkersBuildsError,
} from "./Api.ts";
import type { Providers } from "./Providers.ts";

export type BuildVariables = Readonly<Record<string, string | Redacted.Redacted<string>>>;

export interface GitHubRepository {
  /** Owner login, such as `samebase`. */
  readonly owner: string;
  /** Repository name without the owner. */
  readonly name: string;
  /**
   * Production branch. Pushes to other branches build Worker Previews.
   * @default the default branch of the repository on GitHub
   */
  readonly branch?: string;
  /**
   * Numeric GitHub id of the owner. With `repositoryId` and `branch`, it
   * skips the GitHub lookup. Without all three, the provider reads
   * `GET https://api.github.com/repos/{owner}/{name}` with `GITHUB_TOKEN` or
   * `GITHUB_ACCESS_TOKEN` when set, else without a token (public
   * repositories only).
   */
  readonly ownerId?: number;
  /**
   * Numeric GitHub id of the repository. It stays the same when the
   * repository gets a new name or owner. See `ownerId`.
   */
  readonly repositoryId?: number;
}

export interface RepositoryProps {
  /** Worker id (the Worker tag), such as `worker.workerId` of a `WorkersBuilds.Worker`. */
  readonly worker: string;
  /**
   * The GitHub repository. The Cloudflare Workers and Pages GitHub App must
   * have access to it. The plan reads its GitHub id, and only the id counts:
   * a renamed repository is an update of the same configuration. Another
   * repository is also an update: the deploy deletes the triggers and the
   * configuration, then creates the configuration for the new repository.
   *
   * Without it, the provider uses {@link currentRepository}: the repository
   * of the GitHub Actions run, else the `origin` remote of the current
   * directory. When that is another repository than the configuration
   * builds from, the plan shows an update and the deploy fails: only an
   * explicit `repository` moves the configuration to another repository.
   */
  readonly repository?: GitHubRepository;
  /** Build command, such as `pnpm run build`. */
  readonly buildCommand: string;
  /** Production deploy command. @default "npx wrangler deploy" */
  readonly deployCommand?: string;
  /**
   * Deploy command for every other branch. Worker Previews need a command
   * that runs `wrangler preview`.
   * @default "npx wrangler preview"
   */
  readonly previewDeployCommand?: string;
  /** Directory where the commands run, relative to the repository root. @default "/" */
  readonly rootDirectory?: string;
  /** Paths whose changes start a build. @default ["*"] */
  readonly pathIncludes?: readonly string[];
  /** Paths whose changes never start a build. @default [] */
  readonly pathExcludes?: readonly string[];
  /** @default true */
  readonly buildCachingEnabled?: boolean;
  /**
   * Build token uuid. Builds deploys with the API token behind it. Without
   * it, a new configuration uses the account's first build token (by name,
   * newest first), and an existing configuration keeps its token. When the
   * account has no build token, the provider registers the stack's API token
   * as a build token named `alchemy-<stack name>`.
   */
  readonly buildToken?: string;
  /**
   * Worker Previews: one preview deployment and URL per branch. A
   * configuration that Cloudflare creates with legacy branch triggers is
   * migrated to Worker Previews.
   * @default true
   */
  readonly previews?: boolean;
  /**
   * Build variables for production and preview builds. `Redacted` values are
   * written as secrets: Cloudflare stores them and never returns them.
   * Removing a key here removes the variable on the next deploy.
   */
  readonly variables?: BuildVariables;
  /**
   * Build variables for preview builds only. A key here replaces the same key
   * of `variables` in preview builds, such as a preview deploy key.
   */
  readonly previewVariables?: BuildVariables;
}

export interface RepositoryAttributes {
  /** The Worker tag that the configuration belongs to. */
  readonly scriptTag: string;
  /** Repository connection uuid, shared by every Worker that builds from the repository. */
  readonly repoConnectionId: string | undefined;
  /** Uuids of the active build triggers, sorted. */
  readonly triggerIds: readonly string[];
  readonly previewsEnabled: boolean;
  readonly accountId: string;
  /**
   * The repository that the configuration builds from, with its GitHub ids,
   * and the production branch, as Workers Builds reports them. Workers
   * Builds keeps the names from the time of the connection, so after a
   * rename on GitHub they can be the old names. The ids stay the same.
   */
  readonly repository: Required<GitHubRepository>;
}

/** The attributes that state from 0.4 holds: no repository. */
type RepositoryAttributesBefore05 = Omit<RepositoryAttributes, "repository">;

/**
 * The Workers Builds configuration that connects a GitHub repository to a
 * Worker.
 *
 * A change is always an update of the one configuration, never a
 * replacement. Another repository or Worker deletes the old triggers and
 * configuration in the same deploy.
 *
 * Destroy removes the triggers and the build configuration. It keeps the
 * Worker and the repository connection: Cloudflare shares one connection
 * between every Worker that builds from the same repository.
 */
export type Repository = Resource<
  "WorkersBuilds.Repository",
  RepositoryProps,
  RepositoryAttributes,
  never,
  Providers
>;
export const Repository = Resource<Repository>("WorkersBuilds.Repository");

export const DEFAULT_DEPLOY_COMMAND = "npx wrangler deploy";
export const DEFAULT_PREVIEW_DEPLOY_COMMAND = "npx wrangler preview";

/** Error code of GET /builds/workers/{script_tag} for a Worker without a configuration. */
const NO_BUILD_CONFIGURATION = 12040;
/** Error codes Workers Builds answers for a trigger that no longer exists. */
const TRIGGER_NOT_FOUND = [10007, 12000];

/**
 * The fields of `/builds/workers` results that the provider reads. Recorded
 * payloads: test/fixtures/cloudflare/builds_workers_*.json.
 */
export const WorkerBuilds = Schema.Struct({
  script_tag: Schema.String,
  git_repository: Schema.Struct({
    provider_type: Schema.String,
    provider_account_id: Schema.String,
    provider_account_name: Schema.String,
    repo_id: Schema.String,
    repo_name: Schema.String,
    branch: Schema.String,
  }),
  previews_enabled: Schema.Boolean,
  production_settings: Schema.Struct({ build_token_uuid: Schema.String }),
});
export type WorkerBuilds = typeof WorkerBuilds.Type;

/**
 * The fields of GET https://api.github.com/repos/{owner}/{name} that the
 * provider reads. Recorded payload: test/fixtures/github/repos_get.json.
 */
export const GitHubRepositoryResponse = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  default_branch: Schema.String,
  owner: Schema.Struct({ id: Schema.Number, login: Schema.String }),
});

/** A GitHub repository as GitHub reports it. */
export interface CurrentRepository {
  /** Owner login, such as `samebase`. */
  readonly owner: string;
  /** Repository name without the owner. */
  readonly name: string;
  readonly defaultBranch: string;
  /** Numeric GitHub id of the owner. */
  readonly ownerId: number;
  /** Numeric GitHub id of the repository. */
  readonly repositoryId: number;
}

/** `null` removes a variable. A Redacted value becomes a secret, which Cloudflare never returns. */
const variablesBody = (variables: BuildVariables, removed: readonly string[]) => ({
  ...Object.fromEntries(removed.map((key) => [key, null])),
  ...Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [
      key,
      Redacted.isRedacted(value)
        ? { value: Redacted.value(value), is_secret: true }
        : { value, is_secret: false },
    ]),
  ),
});

/** Variables of preview builds: `variables` with `previewVariables` on top. */
const previewBuildVariables = (props: RepositoryProps): BuildVariables => ({
  ...props.variables,
  ...props.previewVariables,
});

const removedKeys = (before: BuildVariables | undefined, after: BuildVariables) =>
  Object.keys(before ?? {}).filter((key) => !Object.hasOwn(after, key));

const buildSettings = (
  props: RepositoryProps,
  buildToken: string,
  deployCommand: string,
  environmentVariables: object,
) => ({
  build_command: props.buildCommand,
  deploy_command: deployCommand,
  root_directory: props.rootDirectory ?? "/",
  path_includes: [...(props.pathIncludes ?? ["*"])],
  path_excludes: [...(props.pathExcludes ?? [])],
  build_caching_enabled: props.buildCachingEnabled ?? true,
  build_token_uuid: buildToken,
  environment_variables: environmentVariables,
});

/** POST /accounts/{account_id}/builds/workers. Holds secret values; never log it. */
export const createBody = (input: {
  readonly scriptTag: string;
  readonly props: RepositoryProps;
  readonly repository: Required<GitHubRepository>;
  readonly buildToken: string;
}) => ({
  script_tag: input.scriptTag,
  git_repository: {
    provider_type: "github",
    provider_account_id: String(input.repository.ownerId),
    provider_account_name: input.repository.owner,
    repo_id: String(input.repository.repositoryId),
    repo_name: input.repository.name,
    branch: input.repository.branch,
  },
  production_settings: buildSettings(
    input.props,
    input.buildToken,
    input.props.deployCommand ?? DEFAULT_DEPLOY_COMMAND,
    variablesBody(input.props.variables ?? {}, []),
  ),
  previews_base_config: buildSettings(
    input.props,
    input.buildToken,
    input.props.previewDeployCommand ?? DEFAULT_PREVIEW_DEPLOY_COMMAND,
    variablesBody(previewBuildVariables(input.props), []),
  ),
  previews_enabled: input.props.previews ?? true,
});

/**
 * PATCH /accounts/{account_id}/builds/workers/{script_tag}. Variables that
 * `olds` declared and `news` drops are sent as `null`, which removes them.
 * Variables that someone else added stay. Holds secret values; never log it.
 */
export const updateBody = (input: {
  readonly news: RepositoryProps;
  readonly olds: RepositoryProps | undefined;
  /** The production branch: `repository.branch`, else the default branch on GitHub. */
  readonly branch: string;
  readonly buildToken: string;
}) => {
  const production = input.news.variables ?? {};
  const preview = previewBuildVariables(input.news);
  return {
    git_repository: { branch: input.branch },
    production_settings: buildSettings(
      input.news,
      input.buildToken,
      input.news.deployCommand ?? DEFAULT_DEPLOY_COMMAND,
      variablesBody(production, removedKeys(input.olds?.variables, production)),
    ),
    previews_base_config: buildSettings(
      input.news,
      input.buildToken,
      input.news.previewDeployCommand ?? DEFAULT_PREVIEW_DEPLOY_COMMAND,
      variablesBody(
        preview,
        removedKeys(
          input.olds === undefined ? undefined : previewBuildVariables(input.olds),
          preview,
        ),
      ),
    ),
    previews_enabled: input.news.previews ?? true,
  };
};

/**
 * Update or no change; never a replacement (see the top of this file).
 *
 * `target` is the repository that `news` resolve to, with its GitHub ids,
 * and `output.repository` is the repository that the configuration builds
 * from. Only the repository id counts: GitHub keeps it when a repository
 * gets a new name or owner, and Workers Builds keeps the old names. Another
 * id, branch, Worker, or account, or changed props, is an update. State from
 * 0.4 has no `repository` in its attributes, so the first plan after the
 * upgrade is an update, which saves it.
 *
 * `stables` names the attributes that the update keeps: the Worker tag and
 * the account unless the configuration moves, and the repository connection
 * unless the repository changes.
 */
export const diffRepository = (input: {
  readonly olds: RepositoryProps;
  readonly news: RepositoryProps;
  readonly output: RepositoryAttributes | RepositoryAttributesBefore05;
  readonly accountId: string;
  readonly target: Required<GitHubRepository>;
}): UpdateDiff | undefined => {
  const { olds, news, output, target } = input;
  const moved = output.scriptTag !== news.worker || output.accountId !== input.accountId;
  const sameRepository =
    "repository" in output && output.repository.repositoryId === target.repositoryId;
  const changed =
    moved ||
    !sameRepository ||
    ("repository" in output && output.repository.branch !== target.branch) ||
    havePropsChanged(olds, news);
  if (!changed) return undefined;
  return {
    action: "update",
    stables: moved
      ? []
      : sameRepository
        ? ["scriptTag", "repoConnectionId", "accountId"]
        : ["scriptTag", "accountId"],
  };
};

/** Sorted like the Samebase token picker: name descending, then uuid. */
export const selectBuildToken = (
  tokens: readonly workersBuilds.ListTokensResultItem[],
): string | undefined =>
  tokens
    .flatMap((token) =>
      token.buildTokenUuid
        ? [
            {
              name: token.buildTokenName?.trim().toLowerCase() || "unnamed token",
              uuid: token.buildTokenUuid,
            },
          ]
        : [],
    )
    .sort((left, right) =>
      left.name === right.name
        ? left.uuid.localeCompare(right.uuid)
        : right.name.localeCompare(left.name),
    )[0]?.uuid;

/** Active triggers and their repository connection, in a stable order. */
export const triggerAttributes = (triggers: readonly workersBuilds.ListTriggersResultItem[]) => {
  const active = triggers
    .flatMap((trigger) =>
      trigger.triggerUuid && !trigger.deletedOn
        ? [{ id: trigger.triggerUuid, connection: trigger.repoConnection?.repoConnectionUuid }]
        : [],
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    triggerIds: active.map((trigger) => trigger.id),
    repoConnectionId: active.find((trigger) => trigger.connection)?.connection ?? undefined,
  };
};

const BUILD_TOKEN_PAGE_SIZE = 100;

export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    diff: Effect.fn(function* ({ olds, news, output }) {
      // Unresolved props, such as the tag of a Worker that the same deploy
      // replaces, and an interrupted create: the engine updates when any
      // prop changed. It compares Redacted variable values by content.
      if (!isResolved(news) || output === undefined) return undefined;
      return diffRepository({
        olds,
        news,
        output,
        accountId: yield* currentAccountId,
        target: yield* resolveRepositoryOnce(news.repository),
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const accountId = output?.accountId ?? (yield* currentAccountId);
      const builds = yield* getBuilds(accountId, output?.scriptTag ?? olds.worker);
      if (builds === undefined) return undefined;
      const attributes = yield* attributesOf(accountId, builds);
      // Without state, an existing configuration belongs to someone else until --adopt.
      return output === undefined ? Unowned(attributes) : attributes;
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const accountId = yield* currentAccountId;
      const scriptTag = news.worker;
      const path = `/accounts/${accountId}/builds/workers/${scriptTag}`;
      const repository = yield* resolveRepositoryOnce(news.repository);
      let builds = yield* getBuilds(accountId, scriptTag);
      // Kept when the configuration is created again for another repository.
      const buildToken = news.buildToken ?? builds?.production_settings.build_token_uuid;

      if (
        builds !== undefined &&
        Number(builds.git_repository.repo_id) !== repository.repositoryId
      ) {
        const from = `${builds.git_repository.provider_account_name}/${builds.git_repository.repo_name}`;
        const to = `${repository.owner}/${repository.name}`;
        // Only a configuration that this resource wrote for this Worker
        // moves to another repository. An adopted configuration, or one
        // that an interrupted create found, belongs to someone else.
        if (
          olds === undefined ||
          output?.scriptTag !== scriptTag ||
          output.accountId !== accountId
        ) {
          return yield* new WorkersBuildsError({
            operation: "check Workers Builds repository",
            message: `Worker ${scriptTag} builds from ${from}, not ${to}. Disconnect it in the Cloudflare dashboard first.`,
          });
        }
        // The repository of the run is not an intent to move the builds:
        // a clone of a fork must not take over the configuration.
        if (news.repository === undefined) {
          return yield* new WorkersBuildsError({
            operation: "check Workers Builds repository",
            message: `Worker ${scriptTag} builds from ${from}, not ${to}, the repository of this run. To move the builds to ${to}, pass repository. Else run the deploy from a clone of ${from}.`,
          });
        }
        // Another repository for the same Worker. Workers Builds keeps one
        // configuration per Worker, and its PATCH changes only the branch
        // of the repository. So this reconcile deletes the old triggers and
        // the old configuration first, and then creates the configuration
        // for the new repository below, in that order. If the create fails,
        // the next deploy finds no configuration and creates it.
        yield* deleteConfiguration(accountId, scriptTag);
        builds = undefined;
      }

      if (builds === undefined) {
        builds = yield* cloudflareRequest({
          operation: "create Workers Builds configuration",
          method: "POST",
          path: `/accounts/${accountId}/builds/workers`,
          body: createBody({
            scriptTag,
            props: news,
            repository,
            buildToken: yield* resolveBuildToken(accountId, buildToken),
          }),
          result: WorkerBuilds,
        });
      }

      // Cloudflare can create legacy branch triggers even when the request
      // enables previews, and PATCH cannot enable previews while a legacy
      // trigger exists (error 12048). migrate_to_previews replaces them.
      if ((news.previews ?? true) && !builds.previews_enabled) {
        builds = yield* cloudflareRequest({
          operation: "migrate Workers Builds to Worker Previews",
          method: "POST",
          path: `${path}/migrate_to_previews`,
          body: { deploy_command: news.previewDeployCommand ?? DEFAULT_PREVIEW_DEPLOY_COMMAND },
          result: WorkerBuilds,
        });
      }

      // One PATCH writes every setting, so the result does not depend on what
      // create and migrate kept. `patch_existing_previews` also applies the
      // preview settings to the previews that exist.
      builds = yield* cloudflareRequest({
        operation: "update Workers Builds configuration",
        method: "PATCH",
        path,
        query: { patch_existing_previews: "true" },
        body: updateBody({
          news,
          olds,
          branch: repository.branch,
          buildToken: news.buildToken ?? builds.production_settings.build_token_uuid,
        }),
        result: WorkerBuilds,
      });

      // The configuration moved to another Worker or account, such as when
      // the Worker was replaced. The engine does not delete the old
      // configuration, because this resource is never replaced, so this
      // reconcile does, after the new configuration exists.
      if (
        olds !== undefined &&
        output !== undefined &&
        (output.scriptTag !== scriptTag || output.accountId !== accountId)
      ) {
        yield* deleteConfiguration(output.accountId, output.scriptTag);
      }
      return yield* attributesOf(accountId, builds);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteConfiguration(output.accountId, output.scriptTag);
    }),
  });

/**
 * Deletes the build triggers, as Samebase deletes them, and then the
 * configuration. A trigger or configuration that is already gone is not an
 * error.
 */
const deleteConfiguration = (accountId: string, scriptTag: string) =>
  Effect.gen(function* () {
    for (const triggerUuid of triggerAttributes(yield* listTriggers(accountId, scriptTag))
      .triggerIds) {
      yield* workersBuilds.deleteTrigger({ accountId, triggerUuid }).pipe(
        Effect.catchIf(
          (error) =>
            isNotFound(error) ||
            (error._tag === "UnknownCloudflareError" &&
              error.code !== undefined &&
              TRIGGER_NOT_FOUND.includes(error.code)),
          () => Effect.void,
        ),
        refused("delete build trigger"),
      );
    }
    yield* absentAsUndefined([NO_BUILD_CONFIGURATION])(
      cloudflareRequest({
        operation: "delete Workers Builds configuration",
        method: "DELETE",
        path: `/accounts/${accountId}/builds/workers/${scriptTag}`,
        result: Schema.Unknown,
      }),
    );
  });

const getBuilds = (accountId: string, scriptTag: string) =>
  absentAsUndefined([NO_BUILD_CONFIGURATION])(
    cloudflareRequest({
      operation: "read Workers Builds configuration",
      method: "GET",
      path: `/accounts/${accountId}/builds/workers/${scriptTag}`,
      result: WorkerBuilds,
    }),
  );

const listTriggers = (accountId: string, scriptTag: string) =>
  workersBuilds.listTriggers({ accountId, externalScriptId: scriptTag }).pipe(
    Effect.catchIf(isNotFound, () => Effect.succeed([])),
    refused("list build triggers"),
  );

/** The repository of a configuration, with the GitHub ids that Workers Builds keeps as strings. */
const repositoryOf = ({
  git_repository: repository,
}: WorkerBuilds): Required<GitHubRepository> => ({
  owner: repository.provider_account_name,
  name: repository.repo_name,
  branch: repository.branch,
  ownerId: Number(repository.provider_account_id),
  repositoryId: Number(repository.repo_id),
});

const attributesOf = (accountId: string, builds: WorkerBuilds) =>
  listTriggers(accountId, builds.script_tag).pipe(
    Effect.map((triggers): RepositoryAttributes => ({
      scriptTag: builds.script_tag,
      previewsEnabled: builds.previews_enabled,
      accountId,
      ...triggerAttributes(triggers),
      repository: repositoryOf(builds),
    })),
  );

/**
 * The build token of a new configuration, in this order: `buildToken`, the
 * account's first build token, else the stack's API token, which the
 * provider registers as a build token.
 */
export const resolveBuildToken = (accountId: string, buildToken: string | undefined) =>
  Effect.gen(function* () {
    if (buildToken !== undefined) return buildToken;
    return (yield* firstBuildToken(accountId)) ?? (yield* registerBuildToken(accountId));
  });

const firstBuildToken = (accountId: string) =>
  Effect.gen(function* () {
    const tokens: workersBuilds.ListTokensResultItem[] = [];
    for (let page = 1; ; page += 1) {
      const batch = yield* workersBuilds
        .listTokens({ accountId, page, perPage: BUILD_TOKEN_PAGE_SIZE })
        .pipe(refused("list build tokens"));
      tokens.push(...batch);
      if (batch.length < BUILD_TOKEN_PAGE_SIZE) break;
    }
    return selectBuildToken(tokens);
  });

/**
 * Registers the stack's API token as the build token `alchemy-<stack name>`,
 * with the token id from GET /user/tokens/verify. Workers Builds accepts
 * only API tokens, so an OAuth login or a global API key fails with
 * {@link WorkersBuildsError}. Destroy keeps the build token: it belongs to
 * the account, and other configurations can use it.
 */
const registerBuildToken = (accountId: string) =>
  Effect.gen(function* () {
    const operation = "register build token";
    const credentials = yield* yield* Credentials;
    if (credentials.type !== "apiToken") {
      return yield* new WorkersBuildsError({
        operation,
        message: `Account ${accountId} has no Workers Builds token, and the stack's Cloudflare credentials are not an API token, so the provider cannot register one. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, pass buildToken, or connect any Worker to Git once in the Cloudflare dashboard, which creates one.`,
      });
    }
    const { id } = yield* user.verifyToken({}).pipe(refused("verify API token"));
    // The request holds the token secret; never log it.
    const registered = yield* workersBuilds
      .createToken({
        accountId,
        buildTokenName: `alchemy-${yield* StackName}`,
        buildTokenSecret: Redacted.value(credentials.apiToken),
        cloudflareTokenId: id,
      })
      .pipe(refused(operation));
    if (!registered.buildTokenUuid) {
      return yield* new WorkersBuildsError({
        operation,
        message: `${operation}: the result has no build_token_uuid`,
      });
    }
    return registered.buildTokenUuid;
  });

const gitHubToken = Config.Redacted("GITHUB_TOKEN").pipe(
  Config.orElse(() => Config.Redacted("GITHUB_ACCESS_TOKEN")),
  Config.option,
);

/**
 * GET https://api.github.com/repos/{owner}/{name}: the names as GitHub
 * writes them, the ids that Workers Builds addresses a repository by, and
 * the default branch.
 */
const readGitHubRepository = (repository: { readonly owner: string; readonly name: string }) =>
  Effect.gen(function* () {
    const operation = `read GitHub repository ${repository.owner}/${repository.name}`;
    const token = Option.getOrUndefined(yield* gitHubToken);
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        Accept: "application/vnd.github+json",
        "User-Agent": "@samebase/alchemy-cloudflare-workers-builds",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    );
    const failed = (message: string, status?: number) =>
      new WorkersBuildsError({
        operation,
        ...(status === undefined ? {} : { status }),
        message: `${operation}: ${message}`,
      });
    const response = yield* client
      .execute(token === undefined ? request : HttpClientRequest.bearerToken(request, token))
      .pipe(Effect.mapError((cause) => failed(cause.message)));
    if (response.status !== 200) {
      return yield* failed(
        `HTTP ${response.status}. For a private repository, set GITHUB_TOKEN or pass repository.ownerId, repository.repositoryId, and repository.branch.`,
        response.status,
      );
    }
    const body = yield* response.json.pipe(Effect.mapError((cause) => failed(cause.message)));
    return yield* Schema.decodeUnknownEffect(GitHubRepositoryResponse)(body).pipe(
      Effect.mapError((issue) => failed(`unexpected response: ${issue.message}`)),
      Effect.map((parsed): CurrentRepository => ({
        owner: parsed.owner.login,
        name: parsed.name,
        defaultBranch: parsed.default_branch,
        ownerId: parsed.owner.id,
        repositoryId: parsed.id,
      })),
    );
  });

/** `https://github.com/<owner>/<name>` or `git@github.com:<owner>/<name>`, each with or without `.git`. */
const GITHUB_REMOTE =
  /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

/**
 * The GitHub repository of this run, for a run file that works unchanged in
 * every fork, such as a Worker named after the repository:
 *
 * 1. In GitHub Actions, `GITHUB_REPOSITORY` (Alchemy's `GitHubEnv`).
 * 2. Else the `origin` remote of the current directory
 *    (`git remote get-url origin`).
 *
 * Then it reads the ids and the default branch from GitHub, as
 * `WorkersBuilds.Repository` does. It fails with {@link WorkersBuildsError}
 * when neither source names a GitHub repository or GitHub does not answer.
 * A run file can fail only with `ConfigError`, so pipe it through
 * `Effect.orDie` there.
 */
export const currentRepository = Effect.gen(function* () {
  const actions = yield* GitHubEnv;
  if (actions !== undefined) {
    return yield* readGitHubRepository({ owner: actions.owner, name: actions.repository });
  }
  // Git prints nothing to stdout without a repository or an origin remote,
  // and a missing git fails the spawn: both mean no origin.
  const origin = yield* (yield* ChildProcessSpawner)
    .string(ChildProcess.make("git", ["remote", "get-url", "origin"]))
    .pipe(Effect.orElseSucceed(() => ""));
  const [, owner, name] = GITHUB_REMOTE.exec(origin.trim()) ?? [];
  if (owner === undefined || name === undefined) {
    // Never quote the remote: an https remote can hold a token.
    return yield* new WorkersBuildsError({
      operation: "find GitHub repository",
      message:
        "find GitHub repository: no GitHub repository. Pass repository, run in GitHub Actions, or run in a clone whose origin remote is https://github.com/<owner>/<name> or git@github.com:<owner>/<name>.",
    });
  }
  return yield* readGitHubRepository({ owner, name });
});

/**
 * Everything Workers Builds needs about the repository: `repository`, else
 * {@link currentRepository}, with the GitHub ids and with the default branch
 * when `branch` is absent. One GitHub call at most, and none when the props
 * hold `ownerId`, `repositoryId`, and `branch`.
 */
export const resolveRepository = (repository: GitHubRepository | undefined) =>
  Effect.gen(function* () {
    if (
      repository?.branch !== undefined &&
      repository.ownerId !== undefined &&
      repository.repositoryId !== undefined
    ) {
      return {
        owner: repository.owner,
        name: repository.name,
        branch: repository.branch,
        ownerId: repository.ownerId,
        repositoryId: repository.repositoryId,
      } satisfies Required<GitHubRepository>;
    }
    const github =
      repository === undefined ? yield* currentRepository : yield* readGitHubRepository(repository);
    return {
      owner: github.owner,
      name: github.name,
      branch: repository?.branch ?? github.defaultBranch,
      ownerId: repository?.ownerId ?? github.ownerId,
      repositoryId: repository?.repositoryId ?? github.repositoryId,
    } satisfies Required<GitHubRepository>;
  });

/**
 * {@link resolveRepository} once per deploy and resource: the plan's diff
 * and the apply's reconcile share the result through Alchemy's artifacts of
 * the run, so they decide on the same repository and GitHub gets one call.
 * Only a result is kept, so a failed read is tried again.
 */
const resolveRepositoryOnce = (repository: GitHubRepository | undefined) =>
  Effect.gen(function* () {
    const artifacts = yield* Artifacts;
    const key = `WorkersBuilds.Repository/${JSON.stringify(repository ?? null)}`;
    const resolved = yield* artifacts.get<Required<GitHubRepository>>(key);
    if (resolved !== undefined) return resolved;
    const read = yield* resolveRepository(repository);
    yield* artifacts.set(key, read);
    return read;
  });
