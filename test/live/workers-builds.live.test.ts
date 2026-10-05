// Live round trip through the Alchemy engine against a real Cloudflare account:
// create a Worker shell and its Workers Builds link, read the configuration
// back, change a build variable, and destroy both. Runs only with
// ALCHEMY_WORKERS_BUILDS_LIVE=1 and CLOUDFLARE_API_TOKEN (see env.ts).
//
// Every temporary resource is named tmp-alchemy-workers-builds-*. Assertions
// on the secret variable compare booleans, so a failure never prints a value.
import { randomBytes } from "node:crypto";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect } from "vitest";
import { absentAsUndefined, cloudflareRequest } from "../../src/Api.ts";
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

const Variables = Schema.Record(
  Schema.String,
  Schema.Struct({ is_secret: Schema.Boolean, value: Schema.NullOr(Schema.String) }),
);
const BuildsView = Schema.Struct({
  previews_enabled: Schema.Boolean,
  git_repository: Schema.Struct({ repo_name: Schema.String, branch: Schema.String }),
  production_settings: Schema.Struct({ environment_variables: Variables }),
  previews_base_config: Schema.Struct({
    deploy_command: Schema.String,
    environment_variables: Variables,
  }),
});

const readBuilds = (scriptTag: string) =>
  absentAsUndefined([12040])(
    cloudflareRequest({
      operation: "read Workers Builds configuration",
      method: "GET",
      path: `/accounts/${liveTargets.accountId}/builds/workers/${scriptTag}`,
      result: BuildsView,
    }),
  ).pipe(Effect.provide(api));

const readWorker = (workerId: string) =>
  workers.getBetaWorker({ accountId: liveTargets.accountId, workerId }).pipe(
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
    Effect.provide(api),
  );

test.provider.skipIf(!liveEnabled)(
  "creates a Worker shell and its Builds link, updates a variable, and deletes both",
  (stack) =>
    Effect.gen(function* () {
      const name = `tmp-alchemy-workers-builds-${Date.now()}`;
      const secret = Redacted.make(randomBytes(16).toString("hex"));
      const declare = (greeting: string) =>
        Effect.gen(function* () {
          const worker = yield* WorkersBuilds.Worker("Worker", { name, delete: true });
          const builds = yield* WorkersBuilds.Repository("Builds", {
            worker: worker.workerId,
            repository: {
              owner: liveTargets.owner,
              name: liveTargets.repository,
              branch: liveTargets.branch,
            },
            buildCommand: "npm install",
            variables: { GREETING: greeting, BUILD_SECRET: secret },
            previewVariables: { GREETING: `${greeting} from a preview` },
          });
          return {
            workerId: worker.workerId,
            url: worker.url,
            scriptTag: builds.scriptTag,
            triggerIds: builds.triggerIds,
            previewsEnabled: builds.previewsEnabled,
          };
        });

      let workerId: string | undefined;
      yield* Effect.gen(function* () {
        const first = yield* stack.deploy(declare("one"));
        workerId = first.workerId;
        console.log(
          `created Worker ${name} (${first.workerId}), triggers ${first.triggerIds.join(", ")}`,
        );
        expect(first.scriptTag).toBe(first.workerId);
        expect(first.previewsEnabled).toBe(true);
        expect(first.url?.startsWith(`https://${name}.`)).toBe(true);

        const created = yield* readBuilds(first.scriptTag);
        expect(created?.git_repository).toMatchObject({
          repo_name: liveTargets.repository,
          branch: liveTargets.branch,
        });
        expect(created?.previews_enabled).toBe(true);
        expect(created?.previews_base_config.deploy_command).toBe("npx wrangler preview");
        const production = created?.production_settings.environment_variables;
        expect(production?.["GREETING"]).toMatchObject({ is_secret: false, value: "one" });
        expect(production?.["BUILD_SECRET"]?.is_secret).toBe(true);
        expect(production?.["BUILD_SECRET"]?.value === null).toBe(true);
        expect(created?.previews_base_config.environment_variables["GREETING"]?.value).toBe(
          "one from a preview",
        );

        const second = yield* stack.deploy(declare("two"));
        expect(second.workerId).toBe(first.workerId);
        const updated = yield* readBuilds(second.scriptTag);
        expect(updated?.production_settings.environment_variables["GREETING"]?.value).toBe("two");
        console.log("updated GREETING through the Builds PATCH");
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));

      if (workerId !== undefined) {
        expect(yield* readWorker(workerId)).toBeUndefined();
        console.log(`destroy deleted Worker ${name}`);
      }
    }),
  { timeout: 300_000 },
);
