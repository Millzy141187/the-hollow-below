import { defineConfig } from 'vite';

// The cloud preview hostname is injected per-process so no hostname is committed.
const previewHost = process.env.PREVIEW_HOST;

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: previewHost ? [previewHost] : [],
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: previewHost ? [previewHost] : [],
  },
  build: {
    target: 'es2022',
  },
});
