// The provider collection users merge into a stack:
//   providers: Layer.mergeAll(Cloudflare.providers(), WorkersBuilds.providers())
import * as Provider from "alchemy/Provider";
import { CloudflareApiLive } from "alchemy/Cloudflare";
import * as Layer from "effect/Layer";
import { Repository, RepositoryProvider } from "./Repository.ts";
import { Worker, WorkerProvider } from "./Worker.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("WorkersBuilds") {}

/**
 * Both Workers Builds providers. Credentials and the account come from
 * Alchemy's Cloudflare login, the same way as for `Cloudflare.providers()`.
 * The engine runs provider handlers with the stack's services, so the
 * Cloudflare credentials and account are merged into this layer's output,
 * as `Cloudflare.providers()` does.
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Worker, Repository])).pipe(
    Layer.provide(Layer.mergeAll(WorkerProvider(), RepositoryProvider())),
    Layer.provideMerge(CloudflareApiLive()),
    Layer.orDie,
  );
