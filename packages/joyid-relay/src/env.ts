// Runtime env shape expected by the relay Worker. Consumers bind their
// Durable Object namespace to `AUTH_SESSION` in wrangler.toml.

export interface RelayEnv {
  AUTH_SESSION: DurableObjectNamespace;
}
