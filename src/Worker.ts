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
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { cloudflareRequest, currentAccountId, refused } from "./Api.ts";
import type { Providers } from "./Providers.ts";

export interface WorkerProps {
  /**
   * Worker name: lowercase letters, digits, and dashes. With Worker Previews,
   * at most 54 characters. A new name replaces the Worker. On Wrangler 3 and
   * later, Workers Builds deploys to the connected Worker with this name,
   * whatever `name` the Wrangler file has.
   *
   * Without it, the provider makes a name on create, as other Alchemy
   * resources do: the stack name, the logical id, the stage, and 8 random
   * characters, lowercase and at most 54 characters, such as
   * `myapp-worker-dev-k3m7x2ab`. The name stays in state, and later deploys
   * use the stored name. The name is also the `workers.dev` hostname, so a
   * production Worker usually wants an explicit name.
   */
  readonly name?: string;
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
 * Destroy deletes the Worker with all of its versions and preview URLs. A
 * replacement deletes the old Worker after it creates the new one. A stack
 * that must keep a production Worker on destroy wraps the call:
 * `yield* WorkersBuilds.Worker("Worker", { name }).pipe(Alchemy.RemovalPolicy.retain())`.
 * Alchemy then removes the Worker from state and does not delete it. This
 * also applies to an adopted Worker, because Alchemy destroys adopted and
 * created resources in the same way.
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

/** The create request: props over the defaults. `name` is `props.name` or the physical name. */
export const createRequest = (
  accountId: string,
  name: string,
  props: WorkerProps,
): workers.CreateBetaWorkerRequest => ({
  accountId,
  name,
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

/**
 * A new explicit name or another account is a new Worker; anything else is
 * an edit. `oldName` is the deployed name. A Worker without `name` keeps it,
 * so only an explicit name that differs replaces the Worker.
 */
export const diffWorker = (input: {
  readonly oldName: string;
  readonly news: WorkerProps;
  readonly output: WorkerAttributes | undefined;
  readonly accountId: string;
}) =>
  (input.news.name ?? input.oldName) !== input.oldName ||
  (input.output !== undefined && input.output.accountId !== input.accountId)
    ? ({ action: "replace" } as const)
    : undefined;

/**
 * The name of a Worker without `name`: Alchemy's physical name from the
 * stack name, the logical id, the stage, and the first 8 characters of the
 * instance id, lowercase, at most 54 characters (the limit with Worker
 * Previews). The instance id stays the same until a replacement, so an
 * interrupted create gets the same name again.
 */
export const physicalWorkerName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: 54, suffixLength: 8 });

/** The fields of the PATCH result that the provider checks. */
const EditedWorker = Schema.Struct({ id: Schema.String });

/**
 * `WorkersBuilds.Worker(id)` without props gives the handlers `undefined`
 * props, although Alchemy's handler type says that they are set. Each
 * handler reads its props through this.
 */
const propsOrEmpty = (props: WorkerProps | undefined): WorkerProps => props ?? {};

export const WorkerProvider = () =>
  Provider.succeed(Worker, {
    stables: ["workerId", "name", "accountId"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // Otherwise undefined: the engine updates when any prop changed.
      return diffWorker({
        oldName: output?.name ?? propsOrEmpty(olds).name ?? (yield* physicalWorkerName(id)),
        news: propsOrEmpty(news),
        output,
        accountId: yield* currentAccountId,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      // The Workers API accepts the id or the name in the path. Without
      // both, the name would come from a new instance id, so no Worker has it.
      const key = output?.workerId ?? propsOrEmpty(olds).name;
      if (key === undefined) return undefined;
      const accountId = output?.accountId ?? (yield* currentAccountId);
      const worker = yield* findWorker(accountId, key);
      if (worker === undefined) return undefined;
      const attributes = yield* attributesOf(accountId, worker);
      // Without state, a Worker with this name belongs to someone else until --adopt.
      return output === undefined ? Unowned(attributes) : attributes;
    }),

    reconcile: Effect.fn(function* ({ id, news: props, output }) {
      const news = propsOrEmpty(props);
      const accountId = yield* currentAccountId;
      // The stored name first, so a made name never changes after create.
      const name = output?.name ?? news.name ?? (yield* physicalWorkerName(id));
      // By id first, then by name: this also finds a Worker that an
      // interrupted create made, and a Worker that --adopt takes over.
      const existing =
        (output === undefined ? undefined : yield* findWorker(accountId, output.workerId)) ??
        (yield* findWorker(accountId, name));
      if (existing === undefined) {
        const created = yield* workers
          .createBetaWorker(createRequest(accountId, name, news))
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

    delete: Effect.fn(function* ({ output }) {
      yield* deleteWorker(output);
    }),
  });

/** Deletes the Worker with all of its versions and preview URLs. A missing Worker is not an error. */
export const deleteWorker = (worker: WorkerAttributes) =>
  workers.deleteBetaWorker({ accountId: worker.accountId, workerId: worker.workerId }).pipe(
    Effect.catchTag("WorkerNotFound", () => Effect.void),
    refused("delete Worker"),
  );

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
