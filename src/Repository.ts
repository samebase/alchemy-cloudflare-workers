// WorkersBuilds.Repository: the Workers Builds configuration of one Worker.
//
// It links a GitHub repository to the Worker, sets the production trigger
// and the Worker Previews settings, and writes the build variables. Builds
// then runs the deploy command on each push to the production branch and the
// preview deploy command on every other branch. This resource never deletes
// the Worker.
import * as workersBuilds from "@distilled.cloud/cloudflare/workers_builds";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
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
  /** Production branch. Pushes to other branches build Worker Previews. */
  readonly branch: string;
  /**
   * Numeric GitHub id of the owner. With `repositoryId`, it skips the GitHub
   * lookup. Without both, the provider reads
   * `GET https://api.github.com/repos/{owner}/{name}` with `GITHUB_TOKEN` or
   * `GITHUB_ACCESS_TOKEN` when set, else without a token (public
   * repositories only).
   */
  readonly ownerId?: number;
  /** Numeric GitHub id of the repository. See `ownerId`. */
  readonly repositoryId?: number;
}

export interface RepositoryProps {
  /** Worker id (the Worker tag), such as `worker.workerId` of a `WorkersBuilds.Worker`. */
  readonly worker: string;
  /**
   * The GitHub repository. The Cloudflare Workers and Pages GitHub App must
   * have access to it. A different repository replaces the configuration; a
   * different branch is an update.
   */
  readonly repository: GitHubRepository;
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
   * newest first), and an existing configuration keeps its token.
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
}

/**
 * The Workers Builds configuration that connects a GitHub repository to a
 * Worker.
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
    repo_id: Schema.String,
    repo_name: Schema.String,
    provider_account_name: Schema.String,
  }),
  previews_enabled: Schema.Boolean,
  production_settings: Schema.Struct({ build_token_uuid: Schema.String }),
});
export type WorkerBuilds = typeof WorkerBuilds.Type;

/** The fields of GET https://api.github.com/repos/{owner}/{name} that the provider reads. */
export const GitHubRepositoryResponse = Schema.Struct({
  id: Schema.Number,
  owner: Schema.Struct({ id: Schema.Number }),
});

export interface RepositoryIds {
  readonly ownerId: string;
  readonly repositoryId: string;
}

const variable = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value)
    ? { value: Redacted.value(value), is_secret: true }
    : { value, is_secret: false };

const variablesBody = (variables: BuildVariables, removed: readonly string[]) => ({
  ...Object.fromEntries(removed.map((key) => [key, null])),
  ...Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, variable(value)])),
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
  readonly ids: RepositoryIds;
  readonly buildToken: string;
}) => ({
  script_tag: input.scriptTag,
  git_repository: {
    provider_type: "github",
    provider_account_id: input.ids.ownerId,
    provider_account_name: input.props.repository.owner,
    repo_id: input.ids.repositoryId,
    repo_name: input.props.repository.name,
    branch: input.props.repository.branch,
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
  readonly buildToken: string;
}) => {
  const production = input.news.variables ?? {};
  const preview = previewBuildVariables(input.news);
  return {
    git_repository: { branch: input.news.repository.branch },
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
 * Another Worker, repository, or account is a new configuration; anything
 * else is an update. GitHub names are case-insensitive. Adding the numeric
 * ids of the same repository is an update.
 */
export const diffRepository = (input: {
  readonly olds: RepositoryProps;
  readonly news: RepositoryProps;
  readonly output: RepositoryAttributes | undefined;
  readonly accountId: string;
}) => {
  const before = input.olds.repository;
  const after = input.news.repository;
  const fullName = (repository: GitHubRepository) =>
    `${repository.owner}/${repository.name}`.toLowerCase();
  return input.olds.worker !== input.news.worker ||
    fullName(before) !== fullName(after) ||
    (before.repositoryId !== undefined &&
      after.repositoryId !== undefined &&
      before.repositoryId !== after.repositoryId) ||
    (input.output !== undefined && input.output.accountId !== input.accountId)
    ? ({ action: "replace" } as const)
    : undefined;
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
    stables: ["scriptTag", "repoConnectionId", "accountId"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // Otherwise undefined: the engine updates when any prop changed and
      // compares Redacted variable values by content.
      return diffRepository({ olds, news, output, accountId: yield* currentAccountId });
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
      let builds = yield* getBuilds(accountId, scriptTag);

      if (builds === undefined) {
        const buildToken = news.buildToken ?? (yield* firstBuildToken(accountId));
        builds = yield* cloudflareRequest({
          operation: "create Workers Builds configuration",
          method: "POST",
          path: `/accounts/${accountId}/builds/workers`,
          body: createBody({
            scriptTag,
            props: news,
            ids: yield* resolveRepositoryIds(news.repository),
            buildToken,
          }),
          result: WorkerBuilds,
        });
      } else if (output === undefined) {
        // Adopted, or created by an interrupted run: it must build this repository.
        const ids = yield* resolveRepositoryIds(news.repository);
        if (builds.git_repository.repo_id !== ids.repositoryId) {
          return yield* new WorkersBuildsError({
            operation: "adopt Workers Builds configuration",
            message: `Worker ${scriptTag} builds from ${builds.git_repository.provider_account_name}/${builds.git_repository.repo_name}, not ${news.repository.owner}/${news.repository.name}. Disconnect it in the Cloudflare dashboard first.`,
          });
        }
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
          buildToken: news.buildToken ?? builds.production_settings.build_token_uuid,
        }),
        result: WorkerBuilds,
      });
      return yield* attributesOf(accountId, builds);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { accountId, scriptTag } = output;
      // Triggers first, as Samebase deletes them, then the configuration.
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
    }),
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

const attributesOf = (accountId: string, builds: WorkerBuilds) =>
  listTriggers(accountId, builds.script_tag).pipe(
    Effect.map((triggers): RepositoryAttributes => ({
      scriptTag: builds.script_tag,
      previewsEnabled: builds.previews_enabled,
      accountId,
      ...triggerAttributes(triggers),
    })),
  );

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
    const uuid = selectBuildToken(tokens);
    if (uuid === undefined) {
      return yield* new WorkersBuildsError({
        operation: "select build token",
        message: `Account ${accountId} has no Workers Builds token. Connect any Worker to Git once in the Cloudflare dashboard, which creates one, or pass buildToken.`,
      });
    }
    return uuid;
  });

const gitHubToken = Config.Redacted("GITHUB_TOKEN").pipe(
  Config.orElse(() => Config.Redacted("GITHUB_ACCESS_TOKEN")),
  Config.option,
);

/** The numeric GitHub ids that Workers Builds addresses a repository by. */
export const resolveRepositoryIds = (repository: GitHubRepository) =>
  Effect.gen(function* () {
    if (repository.ownerId !== undefined && repository.repositoryId !== undefined) {
      return { ownerId: String(repository.ownerId), repositoryId: String(repository.repositoryId) };
    }
    const operation = `read GitHub repository ${repository.owner}/${repository.name}`;
    const token = Option.getOrUndefined(yield* gitHubToken);
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        Accept: "application/vnd.github+json",
        "User-Agent": "@samebase/alchemy-cloudflare-workers",
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
        `HTTP ${response.status}. For a private repository, set GITHUB_TOKEN or pass repository.ownerId and repository.repositoryId.`,
        response.status,
      );
    }
    const body = yield* response.json.pipe(Effect.mapError((cause) => failed(cause.message)));
    const parsed = yield* Schema.decodeUnknownEffect(GitHubRepositoryResponse)(body).pipe(
      Effect.mapError((issue) => failed(`unexpected response: ${issue.message}`)),
    );
    return {
      ownerId: String(repository.ownerId ?? parsed.owner.id),
      repositoryId: String(repository.repositoryId ?? parsed.id),
    };
  });
