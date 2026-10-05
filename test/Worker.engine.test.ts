// WorkersBuilds.Worker through the real Alchemy engine over the fake API in
// engine.ts: what drift detection sees.
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import * as WorkersBuilds from "../src/index.ts";
import { engine, type FakeApi, fakeApi, type StoredWorker } from "./engine.ts";

const program = (props: WorkersBuilds.WorkerProps) =>
  Effect.gen(function* () {
    const worker = yield* WorkersBuilds.Worker("Worker", props);
    return { workerId: worker.workerId };
  });

/** Changes the Worker as the Cloudflare dashboard or a `wrangler deploy` would. */
const edit = (api: FakeApi, workerId: string, change: (worker: StoredWorker) => StoredWorker) => {
  const current = api.workers.get(workerId);
  if (current === undefined) throw new Error("no Worker");
  api.workers.set(workerId, change(current));
};

describe("drift", () => {
  it("plans an update for a declared observability setting that changed, and the repair restores it", async () => {
    const api = fakeApi();
    const deploy = engine(api);
    const { workerId } = await deploy.deploy(
      program({ name: "my-app", observability: { enabled: true, headSamplingRate: 1 } }),
    );
    expect((await deploy.drift()).result.resources["Worker"]?.action).toBe("unchanged");

    edit(api, workerId, (worker) => ({
      ...worker,
      observability: { ...worker.observability, enabled: false },
    }));
    const drift = await deploy.drift();
    expect(drift.result.resources["Worker"]?.action).toBe("drifted");
    expect(drift.plan.resources["Worker"]?.action).toBe("update");

    await deploy.repair();
    expect(api.workers.get(workerId)?.observability).toMatchObject({ enabled: true });
    expect((await deploy.drift()).result.resources["Worker"]?.action).toBe("unchanged");
  });

  it("ignores a setting that the props leave out, which the Wrangler file can own", async () => {
    const api = fakeApi();
    const deploy = engine(api);
    const { workerId } = await deploy.deploy(program({ name: "my-app", logpush: false }));

    edit(api, workerId, (worker) => ({
      ...worker,
      observability: { ...worker.observability, enabled: true },
      tags: ["from-the-dashboard"],
    }));
    expect((await deploy.drift()).result.resources["Worker"]?.action).toBe("unchanged");

    edit(api, workerId, (worker) => ({ ...worker, logpush: true }));
    expect((await deploy.drift()).result.resources["Worker"]?.action).toBe("drifted");
  });
});
