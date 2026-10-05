import { readFileSync } from "node:fs";
import { InstanceId } from "alchemy/InstanceId";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  createRequest,
  DEFAULT_OBSERVABILITY,
  diffWorker,
  editBody,
  physicalWorkerName,
  type WorkerAttributes,
  workersDevUrl,
} from "../src/Worker.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

const accountId = "fe57d01d7ab41f60d00ba1aade20eb33";

describe("createRequest", () => {
  it("sends the Samebase create defaults for a name alone", () => {
    expect(createRequest(accountId, "my-app", {})).toEqual({
      accountId,
      name: "my-app",
      logpush: false,
      subdomain: { enabled: true, previewsEnabled: true },
      observability: {
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
      },
      tags: [],
      tailConsumers: [],
    });
  });

  it("puts each declared setting over its default", () => {
    const request = createRequest(accountId, "my-app", {
      logpush: true,
      subdomain: { enabled: false, previewsEnabled: true },
      tags: ["team:web"],
      tailConsumers: [{ name: "log-sink" }],
    });
    expect(request).toMatchObject({
      logpush: true,
      subdomain: { enabled: false, previewsEnabled: true },
      observability: DEFAULT_OBSERVABILITY,
      tags: ["team:web"],
      tailConsumers: [{ name: "log-sink" }],
    });
  });
});

describe("editBody", () => {
  it("is empty when the props name no setting, so Wrangler keeps its settings", () => {
    expect(editBody({ delete: true })).toEqual({});
  });

  it("holds only the declared settings, in the API's snake_case", () => {
    expect(
      editBody({
        subdomain: { enabled: true, previewsEnabled: false },
        observability: { enabled: true, headSamplingRate: 0.5, logs: { invocationLogs: false } },
        tailConsumers: [{ name: "log-sink" }],
      }),
    ).toEqual({
      subdomain: { enabled: true, previews_enabled: false },
      observability: {
        enabled: true,
        head_sampling_rate: 0.5,
        logs: { invocation_logs: false },
      },
      tail_consumers: [{ name: "log-sink" }],
    });
  });
});

describe("workersDevUrl", () => {
  const RecordedPreview = Schema.Struct({ urls: Schema.Array(Schema.String) });

  it("matches the host of a recorded preview URL", () => {
    const name = "tmp-native-preview-template-native-previews";
    const url = workersDevUrl(name, "rir");
    expect(url).toBe(`https://${name}.rir.workers.dev`);
    // A preview URL is `<preview>-<name>.<subdomain>.workers.dev`.
    const [preview] = Schema.decodeUnknownSync(RecordedPreview)(
      fixture("cloudflare/workers_previews_get.json"),
    ).urls;
    expect(preview?.endsWith(`-${name}.rir.workers.dev`)).toBe(true);
  });

  it("is undefined when the account has no workers.dev subdomain", () => {
    expect(workersDevUrl("my-app", undefined)).toBeUndefined();
  });
});

describe("diffWorker", () => {
  const output: WorkerAttributes = {
    workerId: "eaeec9c35fa64976a823c246164f4204",
    name: "my-app",
    url: "https://my-app.rir.workers.dev",
    accountId,
  };

  it("replaces the Worker for a new name", () => {
    expect(
      diffWorker({ oldName: "my-app", news: { name: "my-app-2" }, output, accountId }),
    ).toEqual({ action: "replace" });
  });

  it("keeps the deployed name when the props leave it out", () => {
    const made = { ...output, name: "myapp-worker-dev-j4gduhm3" };
    expect(diffWorker({ oldName: made.name, news: {}, output: made, accountId })).toBeUndefined();
    expect(
      diffWorker({ oldName: made.name, news: { name: made.name }, output: made, accountId }),
    ).toBeUndefined();
    expect(diffWorker({ oldName: "my-app", news: {}, output, accountId })).toBeUndefined();
  });

  it("replaces the Worker for another account", () => {
    expect(
      diffWorker({
        oldName: "my-app",
        news: { name: "my-app" },
        output,
        accountId: "00000000000000000000000000000000",
      }),
    ).toEqual({ action: "replace" });
  });

  it("leaves settings changes to the engine, which updates through PATCH", () => {
    expect(
      diffWorker({
        oldName: "my-app",
        news: { name: "my-app", logpush: true, delete: true },
        output,
        accountId,
      }),
    ).toBeUndefined();
  });
});

describe("physicalWorkerName", () => {
  /** 16 bytes, hex, as the engine makes an instance id. Base32 starts with `j4gduhm3`. */
  const instanceId = "4f0c3a1d9b2e47a8b6c5d4e3f2a1b0c9";

  const nameIn = (stack: string, stage: string, id: string) =>
    Effect.runSync(
      physicalWorkerName(id).pipe(
        Effect.provideService(Stack, {
          name: stack,
          stage,
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, stage),
        Effect.provideService(InstanceId, instanceId),
      ),
    );

  it("joins the stack, the logical id, the stage, and 8 instance characters in lowercase", () => {
    expect(nameIn("MyApp", "dev", "Worker")).toBe("myapp-worker-dev-j4gduhm3");
  });

  it("turns other characters into dashes, as the Workers API accepts only these", () => {
    const name = nameIn("my_app", "pr_42", "Web.Worker");
    expect(name).toBe("my-app-web-worker-pr-42-j4gduhm3");
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it("keeps a long name at 54 characters, the limit with Worker Previews, and keeps the suffix", () => {
    const name = nameIn("a-stack-name-that-is-long-enough", "production", "WorkerOfTheApp");
    expect(name).toHaveLength(54);
    expect(name.endsWith("j4gduhm3")).toBe(true);
  });
});
