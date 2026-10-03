import { defineConfig } from 'vite';
import { qwikVite } from '@builder.io/qwik/optimizer';

// 仅用于 scripts/smoke-ssr 第一阶段：构建客户端并产出 q-manifest.json
export default defineConfig({
  configFile: false,
  plugins: [qwikVite({
    csr: false,
    client: { input: ['src/main.tsx'], outDir: 'dist-smoke/client' }
  })],
  build: { target: 'es2022', minify: false, outDir: 'dist-smoke/client' }
});
