// WorkersBuilds.Secret: one secret of a Worker that Workers Builds deploys.
//
// The secret is written through the classic Workers script API
// (/accounts/{account_id}/workers/scripts/{script_name}/secrets), which
// addresses the Worker by name. `wrangler deploy` keeps the secrets of a
// Worker, so a secret that the stack writes stays across builds and never
// conflicts with the Wrangler file.
import * as workers from "@distilled.cloud/cloudflare/workers";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  absentAsUndefined,
  cloudflareRequest,
  currentAccountId,
  isNotFound,
  refused,
  WorkersBuildsError,
} from "./Api.ts";
import type { Providers } from "./Providers.ts";

export interface SecretProps {
  /**
   * Worker name, such as `worker.name` of a `WorkersBuilds.Worker`. The
   * secrets endpoints address the Worker by name, not by id. The Worker must
   * exist. A different Worker replaces the secret.
   */
  readonly worker: string;
  /** Secret name, which is also the binding name in `env`. A different name replaces the secret. */
  readonly name: string;
  /** Secret value. Cloudflare stores it and never returns it. A different value updates the secret. */
  readonly value: Redacted.Redacted<string>;
}

export interface SecretAttributes {
  readonly workerName: string;
  readonly name: string;
  readonly accountId: string;
}

/**
 * A secret of a Worker that Workers Builds deploys.
 *
 * Each write and each delete creates a new version of the Worker. Wrangler
 * keeps secrets on deploy, so the next build keeps this secret. Cloudflare
 * never returns the value: read checks only that the name exists.
 *
 * Destroy deletes the secret.
 */
export type Secret = Resource<
  "WorkersBuilds.Secret",
  SecretProps,
  SecretAttributes,
  never,
  Providers
>;
export const Secret = Resource<Secret>("WorkersBuilds.Secret");

/** Error code of the Workers script endpoints for a Worker that does not exist. */
const WORKER_NOT_FOUND = 10007;

/**
 * The items of GET .../secrets: names and types, never values. The distilled
 * list type requires `text`, which the API never returns, so the provider
 * reads the list with this schema.
 */
export const ScriptSecrets = Schema.Array(
  Schema.Struct({ name: Schema.String, type: Schema.String }),
);

/** PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets. Holds the secret value; never log it. */
export const putRequest = (
  accountId: string,
  props: SecretProps,
): workers.PutScriptSecretRequest => ({
  accountId,
  scriptName: props.worker,
  name: props.name,
  text: Redacted.value(props.value),
  type: "secret_text",
});

/** Another Worker, name, or account is a new secret; a new value is an update. */
export const diffSecret = (input: {
  readonly olds: SecretProps;
  readonly news: SecretProps;
  readonly output: SecretAttributes | undefined;
  readonly accountId: string;
}) =>
  input.olds.worker !== input.news.worker ||
  input.olds.name !== input.news.name ||
  (input.output !== undefined && input.output.accountId !== input.accountId)
    ? ({ action: "replace" } as const)
    : undefined;

/** Whether the Worker has a secret with this name. `false` when the Worker does not exist. */
export const secretExists = (secret: SecretAttributes) =>
  absentAsUndefined([WORKER_NOT_FOUND])(
    cloudflareRequest({
      operation: "list Worker secrets",
      method: "GET",
      path: `/accounts/${secret.accountId}/workers/scripts/${secret.workerName}/secrets`,
      result: ScriptSecrets,
    }),
  ).pipe(
    Effect.map(
      (secrets) => secrets !== undefined && secrets.some(({ name }) => name === secret.name),
    ),
  );

/** Creates or updates the secret. A missing Worker fails with {@link WorkersBuildsError}. */
export const putSecret = (accountId: string, props: SecretProps) =>
  workers.putScriptSecret(putRequest(accountId, props)).pipe(
    Effect.catchIf(
      (error) => error._tag === "WorkerNotFound" || isNotFound(error),
      () =>
        Effect.fail(
          new WorkersBuildsError({
            operation: "put Worker secret",
            message: `put Worker secret: Worker "${props.worker}" was not found in account ${accountId}. Create the Worker first, such as with WorkersBuilds.Worker, and pass its name.`,
          }),
        ),
    ),
    refused("put Worker secret"),
  );

/** Deletes the secret. A missing secret or Worker is not an error. */
export const deleteSecret = (secret: SecretAttributes) =>
  workers
    .deleteScriptSecret({
      accountId: secret.accountId,
      scriptName: secret.workerName,
      secretName: secret.name,
    })
    .pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "SecretNotFound" || error._tag === "WorkerNotFound" || isNotFound(error),
        () => Effect.void,
      ),
      refused("delete Worker secret"),
    );

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["workerName", "name", "accountId"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // Otherwise undefined: the engine updates when the value changed. It
      // compares Redacted values by content.
      return diffSecret({ olds, news, output, accountId: yield* currentAccountId });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const secret: SecretAttributes = output ?? {
        workerName: olds.worker,
        name: olds.name,
        accountId: yield* currentAccountId,
      };
      if (!(yield* secretExists(secret))) return undefined;
      // Without state, a secret with this name belongs to someone else until
      // --adopt. Cloudflare never returns the value, so the update that
      // follows the adoption writes it.
      return output === undefined ? Unowned(secret) : secret;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const accountId = yield* currentAccountId;
      yield* putSecret(accountId, news);
      return { workerName: news.worker, name: news.name, accountId };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteSecret(output);
    }),
  });
