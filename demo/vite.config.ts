// Builds the demo page into dist/demo, which the Worker serves as its static assets, as
// wrangler.jsonc's `assets` says. `npm run demo:dev` rebuilds it on each change.
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('.'),
  plugins: [vue()],
  build: {
    outDir: here('../dist/demo'),
    emptyOutDir: true,
    rollupOptions: { input: { index: here('index.html'), callback: here('callback.html') } },
  },
});
