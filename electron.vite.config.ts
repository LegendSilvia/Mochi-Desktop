import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Mastra and its transitive deps are ESM-only and pull in native/optional modules
// (libsql bindings, MCP transports). Bundling them into the main chunk breaks those
// resolutions, so they stay external and ship in node_modules via electron-builder.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@mastra-app': resolve('src/mastra')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // Two entries: the app window, and the transparent always-on-top window
        // the mascot floats in so it can sit over the whole desktop rather than
        // being trapped inside the app.
        input: {
          index: resolve('src/renderer/index.html'),
          mascot: resolve('src/renderer/mascot.html')
        }
      }
    },
    plugins: [react()]
  }
})
