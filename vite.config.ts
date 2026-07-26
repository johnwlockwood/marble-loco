import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// iOS will not hand out the motion sensors outside a secure context, and it
// does not treat a LAN http:// origin as one. So playing with tilt on a real
// phone means serving the dev build over TLS: `npm run dev:https`.
const https = process.env.HTTPS === '1';

export default defineConfig({
  base: './',
  plugins: https ? [basicSsl()] : [],
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
