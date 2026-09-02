import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // Build straight into docs/ so GitHub Pages can serve main:/docs.
  build: { outDir: 'docs', chunkSizeWarningLimit: 6000 },
})
