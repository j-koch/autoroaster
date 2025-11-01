import { defineConfig } from 'vite';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  // Custom domain (autoroaster.com) serves from root
  base: '/',
  
  // Build configuration
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    
    // Multiple entry points (one per HTML page)
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        training: resolve(__dirname, 'training.html')
      }
    }
  },
  
  // Development server configuration
  server: {
    port: 3000,
    open: true
  },
  
  // No special dependency optimization needed since ONNX Runtime is loaded via CDN
  optimizeDeps: {}
});
