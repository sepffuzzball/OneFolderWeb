import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4317',
      '/thumb': 'http://localhost:4317',
      '/file': 'http://localhost:4317',
    },
  },
});
