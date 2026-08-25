import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
    // Keep the initial payload small on a phone: the editor and the chart
    // library are only needed on screens the user may never open.
    //
    // The function form (rather than the record form) is what current Rollup
    // types accept, and it lets one rule cover a whole dependency subtree —
    // CodeMirror ships as a dozen separate packages.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) {
            return 'react';
          }
          if (/[\\/]node_modules[\\/](@codemirror|@uiw|@lezer|codemirror)[\\/]/.test(id)) {
            return 'editor';
          }
          if (/[\\/]node_modules[\\/](recharts|d3-|victory-)/.test(id)) return 'charts';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
});
