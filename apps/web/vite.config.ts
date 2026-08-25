import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
// `vitest/config` re-exports Vite's `defineConfig` with the `test` key added;
// importing it from 'vite' would reject the block below at type level.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // In development the API runs separately; proxying keeps the app
    // same-origin so the strict SameSite cookies behave as they do in production.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Only React is named here, and deliberately so.
    //
    // The editor and the chart library used to be named chunks too, with the
    // stated intent of keeping them off a phone's first load. It achieved the
    // opposite: naming a manual chunk puts it in the entry's own graph, so
    // index.html emitted `<link rel="modulepreload">` for both and fetched
    // 362 kB gzipped of CodeMirror and Recharts before the sign-in form —
    // whether or not the visitor ever opened a file or a chart.
    //
    // Left alone, the bundler derives those chunks from the dynamic import
    // boundaries instead (the lazy routes, and the lazy Files panel), which is
    // what actually defers them. React stays named because it genuinely is
    // static, shared by every route, and worth caching across deploys.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) {
            return 'react';
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  test: {
    // The sanitiser parses into a real `<template>` on purpose — testing it
    // needs a DOM, not a string-comparison stand-in.
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
