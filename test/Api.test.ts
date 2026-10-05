import { readFileSync } from "node:fs";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";
import {
  absentAsUndefined,
  PermissionError,
  readEnvelope,
  refused,
  TOKEN_PERMISSIONS,
  WorkersBuildsError,
} from "../src/Api.ts";
import { WorkerBuilds } from "../src/Repository.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

const ErrorEnvelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  messages: Schema.Array(Schema.String),
  result: Schema.Null,
});
const missingConfiguration = () =>
  Schema.decodeUnknownSync(ErrorEnvelope)(
    fixture("cloudflare/builds_workers_get_missing_error.json"),
  );

const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("readEnvelope", () => {
  it("decodes the result of a recorded success response", async () => {
    const body = {
      success: true,
      errors: [],
      messages: [],
      result: fixture("cloudflare/builds_workers_get_native.json"),
    };
    const builds = await Effect.runPromise(readEnvelope("read", 200, body, WorkerBuilds));
    expect(builds.script_tag).toBe("eaeec9c35fa64976a823c246164f4204");
    expect(builds.previews_enabled).toBe(true);
  });

  it("keeps the code and message of a recorded error", async () => {
    const error = await failure(
      readEnvelope(
        "update",
        400,
        fixture("cloudflare/builds_workers_patch_previews_error.json"),
        WorkerBuilds,
      ),
    );
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error).toMatchObject({ status: 400, code: 12048 });
    expect(error.message).toContain("Use the migrate_to_previews endpoint instead.");
  });

  it("fails when a success response has no result of the expected shape", async () => {
    const body = { success: true, errors: [], messages: [], result: null };
    const error = await failure(readEnvelope("read", 200, body, WorkerBuilds));
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error.message).toContain("unexpected result");
  });

  it("reports HTTP 403 as a permission error that names the token and its permissions", async () => {
    const error = await failure(
      readEnvelope("read Workers Builds configuration", 403, missingConfiguration(), WorkerBuilds),
    );
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.message).toContain("CLOUDFLARE_API_TOKEN");
    expect(error.message).toContain("CLOUDFLARE_ACCOUNT_ID");
    for (const permission of TOKEN_PERMISSIONS) expect(error.message).toContain(permission);
  });

  it("reports Builds error 12006 as a permission error", async () => {
    const body = {
      ...missingConfiguration(),
      errors: [{ code: 12006, message: "Invalid token" }],
    };
    const error = await failure(readEnvelope("read", 400, body, WorkerBuilds));
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toMatchObject({ reason: "error 12006" });
  });

  it("reports HTTP 401 without an envelope as a permission error", async () => {
    const error = await failure(readEnvelope("read", 401, undefined, WorkerBuilds));
    expect(error).toMatchObject({ _tag: "WorkersBuildsPermissionError", reason: "HTTP 401" });
  });
});

describe("absentAsUndefined", () => {
  const read = (status: number) =>
    absentAsUndefined([12040])(readEnvelope("read", status, missingConfiguration(), WorkerBuilds));

  it("turns the recorded missing-configuration error into undefined, whatever the status", async () => {
    expect(await Effect.runPromise(read(404))).toBeUndefined();
    expect(await Effect.runPromise(read(400))).toBeUndefined();
  });

  it("keeps other errors", async () => {
    const error = await failure(
      absentAsUndefined([12040])(
        readEnvelope(
          "update",
          400,
          fixture("cloudflare/builds_workers_patch_previews_error.json"),
          WorkerBuilds,
        ),
      ),
    );
    expect(error).toMatchObject({ code: 12048 });
  });
});

/** Serves one response to every request, through the real distilled client. */
const respond = (status: number, body: unknown) =>
  Layer.mergeAll(
    fromApiToken({ apiToken: "test-token" }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        ),
      ),
    ),
  );

describe("refused", () => {
  it("turns a distilled 403 into a permission error", async () => {
    const error = await failure(
      workers
        .getSubdomain({ accountId: "fe57d01d7ab41f60d00ba1aade20eb33" })
        .pipe(
          refused("read workers.dev subdomain"),
          Effect.provide(respond(403, missingConfiguration())),
        ),
    );
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toMatchObject({ reason: "HTTP 403" });
  });

  it("keeps the recorded invalid-name error of a Worker create", async () => {
    const error = await failure(
      workers
        .createBetaWorker({ accountId: "fe57d01d7ab41f60d00ba1aade20eb33", name: "samebase app" })
        .pipe(
          refused("create Worker"),
          Effect.provide(
            respond(400, fixture("cloudflare/workers_create_invalid_name_error.json")),
          ),
        ),
    );
    expect(error).not.toBeInstanceOf(PermissionError);
    expect(error.message).toContain("Invalid Worker name");
  });
});
