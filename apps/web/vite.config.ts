/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // @veyra/contracts é workspace CJS linkado: forçar o pré-bundle garante a
  // resolução confiável dos named exports do barrel no dev server.
  optimizeDeps: {
    include: ['@veyra/contracts'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
  server: {
    // porta fixa com strictPort: se 5175 estiver ocupada, o Vite falha em vez
    // de escorregar silenciosamente para outra porta. VITE_PORT permite ao E2E
    // futuro subir isolado.
    port: Number(process.env.VITE_PORT) || 5175,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
