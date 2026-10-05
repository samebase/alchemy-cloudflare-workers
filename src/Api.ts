// Shared Cloudflare API plumbing for both resources.
//
// `@distilled.cloud/cloudflare` (the client Alchemy uses) covers most calls.
// It does not expose the Workers Builds `/builds/workers` family, and its
// Worker edit type marks every field as required although the API edits only
// the fields it receives. Those calls go through `cloudflareRequest` with the
// same credentials and the same HTTP client.
import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/** Token permissions that the Worker shell and the Builds endpoints need. */
export const TOKEN_PERMISSIONS = [
  "Workers Builds Configuration: Edit",
  "Workers Scripts: Edit",
  "Account Settings: Read",
] as const;

/**
 * Cloudflare refused a call for lack of permission. The usual cause is
 * Alchemy's OAuth login, which has no Workers Builds scope.
 */
export class PermissionError extends Schema.TaggedError<PermissionError>()(
  "WorkersBuildsPermissionError",
  {
    operation: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

/** Any other failed call. `status` and `code` come from the Cloudflare response when it has them. */
export class WorkersBuildsError extends Schema.TaggedError<WorkersBuildsError>()(
  "WorkersBuildsError",
  {
    operation: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    code: Schema.optionalKey(Schema.Number),
    message: Schema.String,
  },
) {}

const permissionError = (operation: string, reason: string) =>
  new PermissionError({
    operation,
    reason,
    message: `Cloudflare refused "${operation}" (${reason}). Workers Builds needs a user-scoped API token: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and give the token these permissions: ${TOKEN_PERMISSIONS.join(", ")}. The Alchemy OAuth login has no Workers Builds scope.`,
  });

/** Workers Builds answers a token without Builds access with error 12006 "Invalid token". */
const BUILDS_INVALID_TOKEN = 12006;

/**
 * Maps the permission failures of a `@distilled.cloud/cloudflare` call to
 * {@link PermissionError}. Distilled turns HTTP 401 into `Unauthorized` and
 * HTTP 403 into `Forbidden`.
 */
export const refused =
  (operation: string) =>
  <A, E extends { readonly _tag: string; readonly code?: number | undefined }, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PermissionError, R> =>
    effect.pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "Forbidden" ||
          error._tag === "Unauthorized" ||
          error.code === BUILDS_INVALID_TOKEN,
        (error) =>
          Effect.fail(
            permissionError(
              operation,
              error._tag === "Forbidden"
                ? "HTTP 403"
                : error._tag === "Unauthorized"
                  ? "HTTP 401"
                  : `error ${BUILDS_INVALID_TOKEN}`,
            ),
          ),
      ),
    );

/** The account the stack deploys into, from Alchemy's Cloudflare profile or environment. */
export const currentAccountId = Effect.gen(function* () {
  const environment = yield* yield* CloudflareEnvironment;
  return environment.accountId;
});

/** The Cloudflare v4 response envelope. */
const Envelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(
    Schema.Struct({ code: Schema.optionalKey(Schema.Number), message: Schema.String }),
  ),
  result: Schema.optionalKey(Schema.Unknown),
});
/** Cloudflare answers a body that is not JSON for some errors, such as an HTML 403 page. */
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope));

export interface CloudflareRequest<A> {
  readonly operation: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path after the API base URL, such as `/accounts/<id>/builds/workers`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: object;
  /** Schema of the envelope's `result`. */
  readonly result: Schema.Decoder<A>;
}

/**
 * One Cloudflare API call with the stack's Cloudflare credentials. Returns
 * the decoded `result`. Fails with {@link PermissionError} for HTTP 401,
 * HTTP 403, or error 12006, and otherwise with {@link WorkersBuildsError},
 * which keeps the first error's code and message. The body can hold
 * secrets; never log it.
 */
export const cloudflareRequest = <A>(request: CloudflareRequest<A>) =>
  Effect.gen(function* () {
    const { operation } = request;
    const credentials = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.make(request.method)(
      `${credentials.apiBaseUrl}${request.path}`,
    ).pipe(
      HttpClientRequest.setHeaders(formatHeaders(credentials)),
      HttpClientRequest.setUrlParams(request.query ?? {}),
    );
    const transportError = (cause: { readonly message: string }) =>
      new WorkersBuildsError({ operation, message: `${operation}: ${cause.message}` });
    const response = yield* client
      .execute(
        request.body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, request.body),
      )
      .pipe(Effect.mapError(transportError));
    const { status } = response;
    const text = yield* response.text.pipe(Effect.mapError(transportError));
    const envelope = Option.getOrUndefined(yield* Effect.option(decodeEnvelope(text)));
    const first = envelope?.errors[0];
    if (status === 401 || status === 403 || first?.code === BUILDS_INVALID_TOKEN) {
      return yield* permissionError(
        operation,
        status === 401 || status === 403 ? `HTTP ${status}` : `error ${BUILDS_INVALID_TOKEN}`,
      );
    }
    if (envelope === undefined) {
      return yield* new WorkersBuildsError({
        operation,
        status,
        message: `${operation}: HTTP ${status} without a Cloudflare response envelope`,
      });
    }
    if (status >= 400 || !envelope.success) {
      return yield* new WorkersBuildsError({
        operation,
        status,
        ...(first?.code === undefined ? {} : { code: first.code }),
        message: `${operation}: ${first?.message ?? `HTTP ${status}`}`,
      });
    }
    return yield* Schema.decodeUnknownEffect(request.result)(envelope.result).pipe(
      Effect.mapError(
        (issue) =>
          new WorkersBuildsError({
            operation,
            status,
            message: `${operation}: unexpected result: ${issue.message}`,
          }),
      ),
    );
  });

/**
 * Turns "not found" into `undefined` so read and delete stay idempotent:
 * HTTP 404, or one of the endpoint's not-found error `codes`.
 */
export const absentAsUndefined =
  (codes: readonly number[]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, E, R> =>
    effect.pipe(
      Effect.catchIf(
        (error) =>
          error instanceof WorkersBuildsError &&
          (error.status === 404 || (error.code !== undefined && codes.includes(error.code))),
        () => Effect.succeed(undefined),
      ),
    );

/**
 * Distilled answers HTTP 404 with `NotFound` at runtime, although the
 * declared error unions of its Workers Builds operations leave that class out.
 */
export const isNotFound = (error: { readonly _tag: string }) => error._tag === "NotFound";
