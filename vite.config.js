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
    outDir: 'docs', // Output build files to 'docs' instead of 'dist'
    // Optional: Ensure assets are correctly pathed for GitHub Pages
    assetsDir: 'assets',
  },
  base: '/',
});
