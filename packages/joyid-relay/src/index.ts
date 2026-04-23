// @byterent/joyid-relay — Cloudflare Worker + Durable Object that
// brokers the JoyID phone→PC auth handshake.
//
// Consumers write a small entry point in their own Worker project:
//
//   // my-worker/src/index.ts
//   import { makeRelayWorker, AuthSession } from '@byterent/joyid-relay';
//
//   export { AuthSession };
//
//   export default makeRelayWorker({
//     allowedOrigins: ['https://mydapp.xyz', 'http://localhost:5173'],
//     logo: {
//       contentType: 'image/png',
//       base64: '...', // your branded PNG
//     },
//   });
//
// ...with a wrangler.toml that binds a Durable Object namespace to
// AuthSession. See packages/joyid-relay/example/ for a ready-to-deploy
// skeleton.

export { AuthSession } from './authSession';
export { makeRelayWorker, type RelayWorkerOptions } from './worker';
export type { RelayEnv } from './env';
