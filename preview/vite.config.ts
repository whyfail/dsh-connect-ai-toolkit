import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), server: { port: 4178, strictPort: true, host: '127.0.0.1' } })
