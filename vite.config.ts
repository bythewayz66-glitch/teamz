import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this project from a sub-path, so assets must be
  // requested from /teamz/ rather than the domain root. If you fork the repo
  // under a different name, keep this in sync (or serve the app from a
  // subfolder on your own server).
  base: '/teamz/',
  server: {
    port: 5173,
    host: true,
  },
});
