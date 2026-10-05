import { readFileSync } from "node:fs";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";
import { WorkersBuildsError } from "../src/Api.ts";
import {
  deleteSecret,
  diffSecret,
  putRequest,
  putSecret,
  ScriptSecrets,
  type SecretAttributes,
  secretExists,
  type SecretProps,
} from "../src/Secret.ts";

const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

const accountId = "fe57d01d7ab41f60d00ba1aade20eb33";
const scripts = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;

const props: SecretProps = {
  worker: "mail",
  name: "MAIL_BRIDGE_SECRET",
  value: Redacted.make("test-secret-value"),
};
const secret: SecretAttributes = { workerName: "mail", name: "MAIL_BRIDGE_SECRET", accountId };

const ErrorEnvelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  messages: Schema.Array(Schema.String),
  result: Schema.Null,
});
const workerNotFound = () =>
  Schema.decodeUnknownSync(ErrorEnvelope)(
    fixture("cloudflare/workers_scripts_not_found_error.json"),
  );
/** The not-found envelope with the code that distilled maps to `SecretNotFound`. */
const secretNotFound = () => {
  const body = workerNotFound();
  return { ...body, errors: body.errors.map((error) => ({ ...error, code: 10056 })) };
};
const invalidName = () => fixture("cloudflare/workers_create_invalid_name_error.json");
const success = (result: unknown) => ({ success: true, errors: [], messages: [], result });

/**
 * Credentials with a placeholder token and an HTTP client that answers every
 * request with `status` and the JSON `body`. Records the requests.
 */
const serve = (status: number, body: unknown) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const layer = Layer.mergeAll(
    fromApiToken({ apiToken: "test-token" }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
      }),
    ),
  );
  return { requests, layer };
};

/** The JSON body that a request sends. */
const jsonBody = (request: HttpClientRequest.HttpClientRequest | undefined): unknown =>
  request?.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("putRequest", () => {
  it("sends the value as secret_text to the Worker that the props name", () => {
    expect(putRequest(accountId, props)).toEqual({
      accountId,
      scriptName: "mail",
      name: "MAIL_BRIDGE_SECRET",
      text: "test-secret-value",
      type: "secret_text",
    });
  });
});

describe("putSecret", () => {
  it("sends one PUT with the name, the text, and the type as its JSON body", async () => {
    const server = serve(200, success(fixture("cloudflare/workers_scripts_secrets_put.json")));
    await run(putSecret(accountId, props).pipe(Effect.provide(server.layer)));
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe(`${scripts}/mail/secrets`);
    expect(request?.headers["authorization"]).toBe("Bearer test-token");
    expect(jsonBody(request)).toEqual({
      name: "MAIL_BRIDGE_SECRET",
      text: "test-secret-value",
      type: "secret_text",
    });
  });

  it("names the Worker and how to create it when the Worker does not exist", async () => {
    for (const status of [400, 404]) {
      const server = serve(status, workerNotFound());
      const error = await failure(putSecret(accountId, props).pipe(Effect.provide(server.layer)));
      expect(error).toBeInstanceOf(WorkersBuildsError);
      expect(error.message).toContain(`Worker "mail" was not found in account ${accountId}`);
      expect(error.message).toContain("WorkersBuilds.Worker");
      expect(error.message).not.toContain("test-secret-value");
    }
  });
});

describe("ScriptSecrets", () => {
  it("decodes the names of a spec-derived list, which holds no values", () => {
    const secrets = Schema.decodeUnknownSync(ScriptSecrets)(
      fixture("cloudflare/workers_scripts_secrets_list.json"),
    );
    expect(secrets.map(({ name, type }) => [name, type])).toEqual([
      ["MAIL_BRIDGE_SECRET", "secret_text"],
      ["MAIL_RECOVERY_ADDRESS", "secret_text"],
      ["SIGNING_KEY", "secret_key"],
    ]);
  });
});

describe("secretExists", () => {
  const listed = () => serve(200, success(fixture("cloudflare/workers_scripts_secrets_list.json")));

  it("finds the name in the Worker's secret list", async () => {
    const server = listed();
    expect(await run(secretExists(secret).pipe(Effect.provide(server.layer)))).toBe(true);
    expect(server.requests[0]?.method).toBe("GET");
    expect(server.requests[0]?.url).toBe(`${scripts}/mail/secrets`);
  });

  it("is false for a name that the list does not hold", async () => {
    const effect = secretExists({ ...secret, name: "MAIL_BRIDGE" });
    expect(await run(effect.pipe(Effect.provide(listed().layer)))).toBe(false);
  });

  it("is false when the Worker does not exist, whatever the status", async () => {
    for (const status of [400, 404]) {
      const server = serve(status, workerNotFound());
      expect(await run(secretExists(secret).pipe(Effect.provide(server.layer)))).toBe(false);
    }
  });

  it("keeps other errors", async () => {
    const server = serve(400, invalidName());
    const error = await failure(secretExists(secret).pipe(Effect.provide(server.layer)));
    expect(error).toMatchObject({ _tag: "WorkersBuildsError", code: 10016 });
  });
});

describe("deleteSecret", () => {
  it("sends DELETE to the path of the secret", async () => {
    const server = serve(200, success(null));
    await run(deleteSecret(secret).pipe(Effect.provide(server.layer)));
    expect(server.requests[0]?.method).toBe("DELETE");
    expect(server.requests[0]?.url).toBe(`${scripts}/mail/secrets/MAIL_BRIDGE_SECRET`);
  });

  it("succeeds when the secret or the Worker does not exist, whatever the status", async () => {
    for (const body of [workerNotFound(), secretNotFound()]) {
      for (const status of [400, 404]) {
        const server = serve(status, body);
        await run(deleteSecret(secret).pipe(Effect.provide(server.layer)));
        expect(server.requests).toHaveLength(1);
      }
    }
  });

  it("keeps other errors", async () => {
    const server = serve(400, invalidName());
    const error = await failure(deleteSecret(secret).pipe(Effect.provide(server.layer)));
    expect(error.message).toContain("Invalid Worker name");
  });
});

describe("diffSecret", () => {
  it.each([
    ["another Worker", { ...props, worker: "mail-2" }],
    ["another name", { ...props, name: "MAIL_RECOVERY_ADDRESS" }],
  ])("replaces the secret for %s", (_, news) => {
    expect(diffSecret({ olds: props, news, output: secret, accountId })).toEqual({
      action: "replace",
    });
  });

  it("replaces the secret for another account", () => {
    expect(
      diffSecret({
        olds: props,
        news: props,
        output: secret,
        accountId: "00000000000000000000000000000000",
      }),
    ).toEqual({ action: "replace" });
  });

  it("leaves a new value to the engine, which updates through one PUT", () => {
    const news = { ...props, value: Redacted.make("other-test-value") };
    expect(diffSecret({ olds: props, news, output: secret, accountId })).toBeUndefined();
  });
});
