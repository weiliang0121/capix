import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, '.', 'OBSERVER_');
  const target = environment.OBSERVER_API_ORIGIN || 'http://127.0.0.1:4320';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (request, incoming) => {
              const origin = incoming.headers.origin;
              if (!origin) return;
              try {
                if (new URL(origin).host === incoming.headers.host) request.setHeader('origin', new URL(target).origin);
              } catch {
                /* Invalid origins remain unchanged for the service to reject. */
              }
            });
          },
        },
      },
    },
  };
});
