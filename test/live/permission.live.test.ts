// Live check of the engine wiring and of the permission error, without a real
// token: a plan through the Alchemy engine sends a placeholder token to the
// Cloudflare API, which refuses the first read. Runs only with
// ALCHEMY_WORKERS_BUILDS_LIVE=1, because it needs the network.
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import * as WorkersBuilds from "../../src/index.ts";
import { liveEnabled, liveTargets } from "./env.ts";

if (liveEnabled) {
  // This test file runs in its own process, so the placeholder stays here.
  process.env["CLOUDFLARE_API_TOKEN"] = "placeholder-token";
  process.env["CLOUDFLARE_ACCOUNT_ID"] = liveTargets.accountId;
}

const { test } = Test.make({ providers: WorkersBuilds.providers() });

test.provider.skipIf(!liveEnabled)(
  "a plan with a token that Cloudflare refuses fails with WorkersBuildsPermissionError",
  (stack) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        stack.plan(
          Effect.gen(function* () {
            const worker = yield* WorkersBuilds.Worker("Worker", {
              name: "tmp-alchemy-workers-builds-permission",
            });
            return { workerId: worker.workerId };
          }),
        ),
      );
      expect(error).toBeInstanceOf(WorkersBuilds.PermissionError);
      expect(error).toMatchObject({ operation: "read Worker", reason: "HTTP 401" });
    }),
  { timeout: 120_000 },
);
