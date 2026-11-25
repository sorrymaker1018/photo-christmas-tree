import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 用相对路径，既能跑在 localhost 根目录，也能直接放到 GitHub Pages 的子路径下
  base: './',
})
