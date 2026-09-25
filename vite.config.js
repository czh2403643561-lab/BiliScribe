import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const apiPort = Number(process.env.BILISCRIBE_API_PORT || 4174)

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
})
