// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      webtorrent: 'webtorrent/dist/webtorrent.min.js',
    },
  },
  // Add this build configuration
  build: {
    target: 'esnext',
    outDir: 'dist', // Output build files to 'docs' instead of 'dist'
  },
});
