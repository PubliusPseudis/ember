// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      webtorrent: 'webtorrent/dist/webtorrent.min.js',
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      onwarn(warning, warn) {
        // Log circular dependencies to help debug
        if (warning.code === 'CIRCULAR_DEPENDENCY') {
          console.log('Circular dependency:', warning.message);
          return;
        }
        warn(warning);
      },
      output: {
        manualChunks: {
          // Split vendor chunks to avoid issues
          'vendor': ['tweetnacl', 'webtorrent', 'dompurify'],
          'tensorflow': ['@tensorflow/tfjs', 'nsfwjs']
        }
      }
    }
  },
  optimizeDeps: {
    exclude: ['nsfwjs'] // Sometimes helps with TensorFlow issues
  }
});
