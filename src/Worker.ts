// WorkersBuilds.Worker: a Cloudflare Worker that exists without code.
//
// The Worker is a shell created through the Workers API
// (POST /accounts/{account_id}/workers/workers). Alchemy never uploads a
// version, bindings, vars, assets, or routes: Workers Builds runs
// `wrangler deploy` from the repository, and the Wrangler file stays the only
// source of truth for the deployed version.
import * as workers from "@distilled.cloud/cloudflare/workers";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { cloudflareRequest, currentAccountId, refused } from "./Api.ts";
import type { Providers } from "./Providers.ts";

export interface WorkerProps {
  /**
   * Worker name: lowercase letters, digits, and dashes. With Worker Previews,
   * at most 54 characters. It must match `name` in the repository's Wrangler
   * file. A new name replaces the Worker.
   */
  readonly name: string;
  /**
   * `workers.dev` route and preview URLs.
   * @default { enabled: true, previewsEnabled: true }
   */
  readonly subdomain?: { readonly enabled: boolean; readonly previewsEnabled: boolean };
  /** Workers Logs and traces. The default enables persisted invocation logs and disables traces. */
  readonly observability?: workers.BetaWorkersCreateRequestObservability;
  /** @default false */
  readonly logpush?: boolean;
  /** @default [] */
  readonly tags?: readonly string[];
  /** Workers that receive this Worker's logs. @default [] */
  readonly tailConsumers?: readonly { readonly name: string }[];
  /**
   * Delete the Worker on destroy or replacement. Deleting a Worker deletes
   * every deployed version and all of its preview URLs. When this is not
   * `true`, destroy only removes the Worker from Alchemy state.
   * @default false
   */
  readonly delete?: boolean;
}

export interface WorkerAttributes {
  /** The Worker's immutable id. Workers Builds calls it the Worker tag or `script_tag`. */
  readonly workerId: string;
  readonly name: string;
  /**
   * `https://<name>.<account subdomain>.workers.dev`, or `undefined` when the
   * account has no `workers.dev` subdomain. It serves only while the
   * `workers.dev` route is enabled.
   */
  readonly url: string | undefined;
  readonly accountId: string;
}

/**
 * A Worker without code, for Workers Builds to deploy into.
 *
 * Wrangler also writes some Worker settings on each `wrangler deploy`:
 * `observability`, `logpush`, `workers_dev` (here `subdomain.enabled`), and
 * `preview_urls` (here `subdomain.previewsEnabled`). The Workers API also
 * accepts `tags` and `tail_consumers`. Each prop you set here is written on
 * create and on every update. Each prop you leave out gets its default on
 * create and is never written again. So when the Wrangler file
 * names a setting, leave that setting out of this resource; then the two
 * never fight.
 *
 * Destroy keeps the Worker unless `delete` is `true`.
 */
export type Worker = Resource<
  "WorkersBuilds.Worker",
  WorkerProps,
  WorkerAttributes,
  never,
  Providers
>;
export const Worker = Resource<Worker>("WorkersBuilds.Worker");

/** Observability on create when the prop is absent: persisted invocation logs, no traces. */
export const DEFAULT_OBSERVABILITY: workers.BetaWorkersCreateRequestObservability = {
  enabled: false,
  headSamplingRate: 1,
  redactQueryString: false,
  logs: {
    destinations: [],
    enabled: true,
    headSamplingRate: 1,
    persist: true,
    invocationLogs: true,
  },
  // No `traces`: Cloudflare rejects `traces.propagationPolicy` unless trace
  // propagation is enabled for the account, even with traces off.
};

/** The create request: props over the defaults. */
export const createRequest = (
  accountId: string,
  props: WorkerProps,
): workers.CreateBetaWorkerRequest => ({
  accountId,
  name: props.name,
  logpush: props.logpush ?? false,
  observability: props.observability ?? DEFAULT_OBSERVABILITY,
  subdomain: props.subdomain ?? { enabled: true, previewsEnabled: true },
  tags: [...(props.tags ?? [])],
  tailConsumers: (props.tailConsumers ?? []).map(({ name }) => ({ name })),
});

const snakeKey = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** The Workers API takes snake_case keys; Alchemy props use camelCase. */
const snakeCase = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(snakeCase)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [snakeKey(key), snakeCase(entry)]),
        )
      : value;

/**
 * The PATCH body: only the settings the props name. PATCH leaves every
 * omitted setting unchanged, so a setting that Wrangler owns stays as the
 * last deploy wrote it.
 */
export const editBody = (props: WorkerProps): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries({
      logpush: props.logpush,
      subdomain: props.subdomain,
      observability: props.observability,
      tags: props.tags,
      tailConsumers: props.tailConsumers,
    }).flatMap(([key, value]) =>
      value === undefined ? [] : [[snakeKey(key), snakeCase(value)] as const],
    ),
  );

export const workersDevUrl = (name: string, subdomain: string | undefined): string | undefined =>
  subdomain === undefined ? undefined : `https://${name}.${subdomain}.workers.dev`;

/** A new name or another account is a new Worker; anything else is an edit. */
export const diffWorker = (input: {
  readonly olds: WorkerProps;
  readonly news: WorkerProps;
  readonly output: WorkerAttributes | undefined;
  readonly accountId: string;
}) =>
  input.olds.name !== input.news.name ||
  (input.output !== undefined && input.output.accountId !== input.accountId)
    ? ({ action: "replace" } as const)
    : undefined;

/** The fields of the PATCH result that the provider checks. */
const EditedWorker = Schema.Struct({ id: Schema.String });

export const WorkerProvider = () =>
  Provider.succeed(Worker, {
    stables: ["workerId", "name", "accountId"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // Otherwise undefined: the engine updates when any prop changed.
      return diffWorker({ olds, news, output, accountId: yield* currentAccountId });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const accountId = output?.accountId ?? (yield* currentAccountId);
      // The Workers API accepts the id or the name in the path.
      const worker = yield* findWorker(accountId, output?.workerId ?? olds.name);
      if (worker === undefined) return undefined;
      const attributes = yield* attributesOf(accountId, worker);
      // Without state, a Worker with this name belongs to someone else until --adopt.
      return output === undefined ? Unowned(attributes) : attributes;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const accountId = yield* currentAccountId;
      // By id first, then by name: this also finds a Worker that an
      // interrupted create made, and a Worker that --adopt takes over.
      const existing =
        (output === undefined ? undefined : yield* findWorker(accountId, output.workerId)) ??
        (yield* findWorker(accountId, news.name));
      if (existing === undefined) {
        const created = yield* workers
          .createBetaWorker(createRequest(accountId, news))
          .pipe(refused("create Worker"));
        return yield* attributesOf(accountId, created);
      }
      const body = editBody(news);
      if (Object.keys(body).length > 0) {
        yield* cloudflareRequest({
          operation: "edit Worker",
          method: "PATCH",
          path: `/accounts/${accountId}/workers/workers/${existing.id}`,
          body,
          result: EditedWorker,
        });
      }
      return yield* attributesOf(accountId, existing);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if (!olds.delete) return;
      yield* workers
        .deleteBetaWorker({ accountId: output.accountId, workerId: output.workerId })
        .pipe(
          Effect.catchTag("WorkerNotFound", () => Effect.void),
          refused("delete Worker"),
        );
    }),
  });

const findWorker = (accountId: string, workerId: string) =>
  workers.getBetaWorker({ accountId, workerId }).pipe(
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
    refused("read Worker"),
  );

const attributesOf = (accountId: string, worker: { readonly id: string; readonly name: string }) =>
  workers.getSubdomain({ accountId }).pipe(
    Effect.map(({ subdomain }) => subdomain),
    Effect.catchTag("SubdomainNotFound", () => Effect.succeed(undefined)),
    refused("read workers.dev subdomain"),
    Effect.map((subdomain): WorkerAttributes => ({
      workerId: worker.id,
      name: worker.name,
      url: workersDevUrl(worker.name, subdomain),
      accountId,
    })),
  );
