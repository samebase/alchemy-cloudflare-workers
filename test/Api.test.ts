import { readFileSync } from "node:fs";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";
import {
  absentAsUndefined,
  cloudflareRequest,
  PermissionError,
  refused,
  TOKEN_PERMISSIONS,
  WorkersBuildsError,
} from "../src/Api.ts";
import { WorkerBuilds } from "../src/Repository.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

const accountId = "fe57d01d7ab41f60d00ba1aade20eb33";

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

/**
 * Credentials with a placeholder token and an HTTP client that answers every
 * request with `status` and `body`, for the real request code. Records the requests.
 */
const respond = (status: number, body: string) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const layer = Layer.mergeAll(
    fromApiToken({ apiToken: "test-token" }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));
      }),
    ),
  );
  return { requests, layer };
};
const respondJson = (status: number, body: unknown) => respond(status, JSON.stringify(body));

const readBuilds = (server: ReturnType<typeof respond>) =>
  cloudflareRequest({
    operation: "read Workers Builds configuration",
    method: "GET",
    path: `/accounts/${accountId}/builds/workers/eaeec9c35fa64976a823c246164f4204`,
    result: WorkerBuilds,
  }).pipe(Effect.provide(server.layer));

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("cloudflareRequest", () => {
  it("decodes the result of a recorded success response", async () => {
    const server = respondJson(200, {
      success: true,
      errors: [],
      messages: [],
      result: fixture("cloudflare/builds_workers_get_native.json"),
    });
    const builds = await run(readBuilds(server));
    expect(builds.script_tag).toBe("eaeec9c35fa64976a823c246164f4204");
    expect(builds.previews_enabled).toBe(true);
  });

  it("sends the credentials, the query, and a JSON body", async () => {
    const server = respondJson(200, {
      success: true,
      errors: [],
      messages: [],
      result: fixture("cloudflare/builds_workers_get_native.json"),
    });
    await run(
      cloudflareRequest({
        operation: "update",
        method: "PATCH",
        path: `/accounts/${accountId}/builds/workers/eaeec9c35fa64976a823c246164f4204`,
        query: { patch_existing_previews: "true" },
        body: { previews_enabled: true },
        result: WorkerBuilds,
      }).pipe(Effect.provide(server.layer)),
    );
    const [request] = server.requests;
    expect(request?.method).toBe("PATCH");
    expect(request?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/workers/eaeec9c35fa64976a823c246164f4204`,
    );
    expect(request?.urlParams.params).toEqual([["patch_existing_previews", "true"]]);
    expect(request?.headers["authorization"]).toBe("Bearer test-token");
    expect(request?.headers["content-type"]).toBe("application/json");
  });

  it("keeps the code and message of a recorded error", async () => {
    const error = await failure(
      readBuilds(respondJson(400, fixture("cloudflare/builds_workers_patch_previews_error.json"))),
    );
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error).toMatchObject({ status: 400, code: 12048 });
    expect(error.message).toContain("Use the migrate_to_previews endpoint instead.");
  });

  it("fails when a success response has no result of the expected shape", async () => {
    const error = await failure(
      readBuilds(respondJson(200, { success: true, errors: [], messages: [], result: null })),
    );
    expect(error).toBeInstanceOf(WorkersBuildsError);
    expect(error.message).toContain("unexpected result");
  });

  it("reports HTTP 403 as a permission error that names the token and its permissions", async () => {
    const error = await failure(readBuilds(respondJson(403, missingConfiguration())));
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.message).toContain("CLOUDFLARE_API_TOKEN");
    expect(error.message).toContain("CLOUDFLARE_ACCOUNT_ID");
    for (const permission of TOKEN_PERMISSIONS) expect(error.message).toContain(permission);
  });

  it("reports Builds error 12006 as a permission error", async () => {
    const body = { ...missingConfiguration(), errors: [{ code: 12006, message: "Invalid token" }] };
    const error = await failure(readBuilds(respondJson(400, body)));
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toMatchObject({ reason: "error 12006" });
  });

  it("reports HTTP 401 with a body that is not JSON as a permission error", async () => {
    const error = await failure(readBuilds(respond(401, "<html>Unauthorized</html>")));
    expect(error).toMatchObject({ _tag: "WorkersBuildsPermissionError", reason: "HTTP 401" });
  });
});

describe("absentAsUndefined", () => {
  it("turns the recorded missing-configuration error into undefined, whatever the status", async () => {
    for (const status of [400, 404]) {
      const server = respondJson(status, missingConfiguration());
      expect(await run(absentAsUndefined([12040])(readBuilds(server)))).toBeUndefined();
    }
  });

  it("keeps other errors", async () => {
    const server = respondJson(400, fixture("cloudflare/builds_workers_patch_previews_error.json"));
    const error = await failure(absentAsUndefined([12040])(readBuilds(server)));
    expect(error).toMatchObject({ code: 12048 });
  });
});

describe("refused", () => {
  it("turns a distilled 403 into a permission error", async () => {
    const error = await failure(
      workers
        .getSubdomain({ accountId })
        .pipe(
          refused("read workers.dev subdomain"),
          Effect.provide(respondJson(403, missingConfiguration()).layer),
        ),
    );
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toMatchObject({ reason: "HTTP 403" });
  });

  it("keeps the recorded invalid-name error of a Worker create", async () => {
    const server = respondJson(400, fixture("cloudflare/workers_create_invalid_name_error.json"));
    const error = await failure(
      workers
        .createBetaWorker({ accountId, name: "samebase app" })
        .pipe(refused("create Worker"), Effect.provide(server.layer)),
    );
    expect(error).not.toBeInstanceOf(PermissionError);
    expect(error.message).toContain("Invalid Worker name");
  });
});
