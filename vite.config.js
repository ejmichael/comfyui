import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' keeps the built app working from any folder or sub-path (GitHub Pages, a USB stick, etc.).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, host: true },
  preview: { host: true },
});
