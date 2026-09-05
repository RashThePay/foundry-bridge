import { defineConfig } from 'vite'

export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    host: true,
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:3847', ws: true },
      '/rooms': 'http://127.0.0.1:3847',
      '/health': 'http://127.0.0.1:3847',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
