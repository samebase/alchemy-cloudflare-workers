// One Worker that Workers Builds deploys from a GitHub repository, with local
// state. The repository holds the Wrangler file; Alchemy creates the Worker
// shell and the Builds link, and never uploads code.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkersBuilds from "../../src/index.ts"; // in your app: "@samebase/alchemy-cloudflare-workers-builds"

export default Alchemy.Stack(
  "WorkersBuildsExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), WorkersBuilds.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* WorkersBuilds.Worker("Worker", {
      name: "tmp-alchemy-workers-builds-example",
    });

    const builds = yield* WorkersBuilds.Repository("Builds", {
      worker: worker.workerId,
      repository: {
        owner: "samebase-live-tests",
        name: "tmp-alchemy-workers-builds-live",
        branch: "main",
      },
      buildCommand: "npm install",
      // Plain values are visible in the dashboard; Redacted values are secrets.
      variables: {
        GREETING: "hello from production",
        BUILD_SECRET: Config.Redacted("EXAMPLE_BUILD_SECRET"),
      },
      previewVariables: { GREETING: "hello from a preview" },
    });

    return {
      url: worker.url,
      workerId: worker.workerId,
      triggerIds: builds.triggerIds,
    };
  }),
);
