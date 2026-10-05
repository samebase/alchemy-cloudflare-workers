// The provider collection users merge into a stack:
//   providers: Layer.mergeAll(Cloudflare.providers(), WorkersBuilds.providers())
import * as Provider from "alchemy/Provider";
import { CloudflareApiLive } from "alchemy/Cloudflare";
import * as Layer from "effect/Layer";
import { Repository, RepositoryProvider } from "./Repository.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Worker, WorkerProvider } from "./Worker.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("WorkersBuilds") {}

/**
 * The Workers Builds providers. Credentials and the account come from
 * Alchemy's Cloudflare login, the same way as for `Cloudflare.providers()`.
 * The engine runs provider handlers with the stack's services, so the
 * Cloudflare credentials and account are merged into this layer's output,
 * as `Cloudflare.providers()` does.
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Worker, Repository, Secret])).pipe(
    Layer.provide(Layer.mergeAll(WorkerProvider(), RepositoryProvider(), SecretProvider())),
    Layer.provideMerge(CloudflareApiLive()),
    Layer.orDie,
  );
