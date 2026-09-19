import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');
  const apiBase = String(env.VITE_API_BASE || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\/$/, '')
    || 'https://solana-poc.onrender.com/api';

  return {
    root,
    envDir: root,
    plugins: [react()],
    server: { port: 5173, strictPort: false },
    build: { outDir: 'dist', sourcemap: true },
    define: {
      'import.meta.env.VITE_API_BASE': JSON.stringify(apiBase),
    },
  };
});
