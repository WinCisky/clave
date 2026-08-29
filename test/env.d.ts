declare module "cloudflare:test" {
  import type { Bindings } from "../src/config.ts";
  export const env: Bindings;
  export const SELF: Fetcher;
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  export function runInDurableObject<T, R>(
    stub: DurableObjectStub,
    callback: (instance: T, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
}
