import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    // The built single-file artifact is committed and served by the Python
    // server as the ui://brandfetch/brand-card.html resource.
    outDir: '../src/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: 'brand-card.html',
    },
  },
})
