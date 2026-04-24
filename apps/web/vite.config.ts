import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

const API_TARGET =
  process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787";
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
  ],
  server: {
    host: "127.0.0.1",
    port: WEB_PORT,
    strictPort: false,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
