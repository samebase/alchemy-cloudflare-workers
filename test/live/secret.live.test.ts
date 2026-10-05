// Live round trip of WorkersBuilds.Secret through the Alchemy engine against a
// real Cloudflare account: create a secret on a Worker shell without code,
// read the secret list back, change the value, remove the secret, and destroy
// the Worker. Runs only with ALCHEMY_WORKERS_BUILDS_LIVE=1 and
// CLOUDFLARE_API_TOKEN (see env.ts). It needs no GitHub repository.
//
// The temporary Worker is named tmp-alchemy-workers-builds-secret-*. The test
// never prints a secret value: the list holds names only.
import { randomBytes } from "node:crypto";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect } from "vitest";
import * as WorkersBuilds from "../../src/index.ts";
import { liveEnabled, liveTargets } from "./env.ts";

// Alchemy reads environment credentials only when both variables are set.
if (liveEnabled) process.env["CLOUDFLARE_ACCOUNT_ID"] ??= liveTargets.accountId;

const { test } = Test.make({ providers: WorkersBuilds.providers() });

/** Direct API access for the read-back, outside the engine. */
const api = Layer.mergeAll(
  fromApiToken({ apiToken: process.env["CLOUDFLARE_API_TOKEN"] ?? "" }),
  FetchHttpClient.layer,
);

const SECRET_NAME = "ALCHEMY_LIVE_SECRET";

/** Secret names of the Worker, read with distilled, not with the provider's own list call. */
const secretNames = (workerName: string) =>
  workers.listScriptSecrets({ accountId: liveTargets.accountId, scriptName: workerName }).pipe(
    Effect.map(({ result }) => result.map((secret) => secret.name)),
    Effect.provide(api),
  );

const readWorker = (workerId: string) =>
  workers.getBetaWorker({ accountId: liveTargets.accountId, workerId }).pipe(
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
    Effect.provide(api),
  );

test.provider.skipIf(!liveEnabled)(
  "creates, updates, and deletes a secret on a Worker shell",
  (stack) =>
    Effect.gen(function* () {
      const name = `tmp-alchemy-workers-builds-secret-${Date.now()}`;
      /** The stack: a Worker shell, and the secret when `value` is set. */
      const declare = (value: string | undefined) =>
        Effect.gen(function* () {
          const worker = yield* WorkersBuilds.Worker("Worker", { name, delete: true });
          if (value !== undefined) {
            yield* WorkersBuilds.Secret("Secret", {
              worker: worker.name,
              name: SECRET_NAME,
              value: Redacted.make(value),
            });
          }
          return { workerId: worker.workerId, workerName: worker.name };
        });

      let workerId: string | undefined;
      yield* Effect.gen(function* () {
        const first = yield* stack.deploy(declare(randomBytes(16).toString("hex")));
        workerId = first.workerId;
        expect(first.workerName).toBe(name);
        expect(yield* secretNames(name)).toContain(SECRET_NAME);
        console.log(`created secret ${SECRET_NAME} on Worker ${name}`);

        // A new value is an update: one PUT on the same name.
        yield* stack.deploy(declare(randomBytes(16).toString("hex")));
        expect(yield* secretNames(name)).toContain(SECRET_NAME);
        console.log(`updated secret ${SECRET_NAME}`);

        // Removing the resource from the stack deletes the secret, and keeps the Worker.
        yield* stack.deploy(declare(undefined));
        expect(yield* secretNames(name)).not.toContain(SECRET_NAME);
        expect(yield* readWorker(first.workerId)).toBeDefined();
        console.log(`deleted secret ${SECRET_NAME}`);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));

      if (workerId !== undefined) {
        expect(yield* readWorker(workerId)).toBeUndefined();
        console.log(`destroy deleted Worker ${name}`);
      }
    }),
  { timeout: 300_000 },
);
