import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// root is src/, so the html pages land at dist/sidepanel.html and dist/options.html.
// Shown on the options page, so it is clear which build is loaded in Chrome.
const now = new Date();
const two = (n: number) => String(n).padStart(2, '0');
const BUILD_TIME = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;

export default defineConfig({
  define: { __BUILD_TIME__: JSON.stringify(BUILD_TIME) },
  root: 'src',
  base: './',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        sidepanel: here('src/sidepanel.html'),
        options: here('src/options.html'),
        background: here('src/background/index.ts'),
      },
      output: {
        // The manifest points at a fixed service worker file name.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
