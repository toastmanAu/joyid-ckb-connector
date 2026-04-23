// Example joyid-relay Worker entry. Copy this + the wrangler.example.toml
// into your own Worker project, fill in your origins and (optionally)
// your branded logo PNG, then `wrangler deploy`.

import { makeRelayWorker, AuthSession } from '@byterent/joyid-relay';

// Export the DO class so wrangler's [[migrations]] can find it.
export { AuthSession };

// Optional branded PNG served at /logo.png. Keeps the Worker response
// self-contained so the phone's "Signed in" page renders with your
// brand, and JoyID's auth screen can fetch this as the dApp icon.
// To keep your logo out of git, read a build-time env var or inline via
// a separate `logo.generated.ts` file.
const LOGO: { contentType: string; base64: string } | undefined = undefined;
// Example:
// const LOGO = {
//   contentType: 'image/png',
//   base64: 'iVBORw0KGgo...',
// };

export default makeRelayWorker({
  allowedOrigins: [
    'https://mydapp.xyz',
    'https://www.mydapp.xyz',
    'http://localhost:5173',
  ],
  logo: LOGO,
});
