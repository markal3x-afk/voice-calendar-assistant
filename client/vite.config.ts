import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        // Backend runs HTTPS locally (self-signed dev cert); secure:false accepts it
        target: 'https://localhost:3000',
        changeOrigin: true,
        ws: true,
        secure: false
      }
    }
  }
})
