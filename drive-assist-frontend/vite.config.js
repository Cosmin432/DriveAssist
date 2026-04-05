import { defineConfig } from 'vite';

/** Proxy WebSocket to Python so the browser uses same origin as the dev server (avoids many handshake / PNA issues). */
export default defineConfig({
  server: {
    proxy: {
      '/ws': {
        target: 'http://127.0.0.1:8765',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});