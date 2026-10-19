import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the built app can be served from any sub-path
  // (GitHub Pages, a subfolder on your own server, or a static preview).
  base: './',
  server: {
    port: 5173,
    host: true,
  },
});
