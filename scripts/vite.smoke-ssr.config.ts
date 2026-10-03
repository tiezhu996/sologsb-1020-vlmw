import { defineConfig } from 'vite';
import { qwikVite } from '@builder.io/qwik/optimizer';
import { readFileSync } from 'node:fs';

// 仅用于 scripts/smoke-ssr 第二阶段：用客户端清单构建 SSR 产物
const manifest = JSON.parse(readFileSync(new URL('../dist-smoke/client/q-manifest.json', import.meta.url), 'utf8'));

export default defineConfig({
  configFile: false,
  plugins: [qwikVite({
    csr: false,
    client: { input: ['src/main.tsx'], outDir: 'dist-smoke/client' },
    ssr: { input: 'scripts/ssr-entry-for-build.tsx', outDir: 'dist-smoke/server', manifestInput: manifest }
  })],
  build: {
    target: 'es2022',
    minify: false,
    ssr: 'scripts/ssr-entry-for-build.tsx',
    outDir: 'dist-smoke/server',
    rollupOptions: { output: { format: 'esm', entryFileNames: 'server.mjs' } }
  }
});
