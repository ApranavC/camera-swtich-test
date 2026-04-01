import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Allow any host (ngrok, preview envs, etc.)
    // Set to true for Vite 6+ — "all" string is not supported.
    allowedHosts: true,
  },
});
