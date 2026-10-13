import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// iOS will not hand out the motion sensors outside a secure context, and it
// does not treat a LAN http:// origin as one. So playing with tilt on a real
// phone means serving the dev build over TLS: `npm run dev:https`.
const https = process.env.HTTPS === '1';

export default defineConfig({
  // Relative, not absolute. This is what lets the built site run from a
  // subpath -- a GitHub Pages project site is served at /marble-loco/, and an
  // absolute base would 404 every asset there.
  base: './',
  plugins: https ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
    // `tailscale serve` proxies https://<machine>.<tailnet>.ts.net here with a
    // real certificate -- the easiest way to get tilt working on a phone.
    // Vite rejects unknown Host headers by default, so allow the tailnet.
    allowedHosts: ['.ts.net'],
  },
  build: {
    target: 'es2020',
    // Off by default: the map is ~2.9MB against a 604KB bundle, so it would be
    // five sixths of every deploy. Build with SOURCEMAP=1 when you need a
    // readable stack trace from a real device.
    sourcemap: process.env.SOURCEMAP === '1',
  },
});
