import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Static marketing site. `public/assets` is served verbatim at /assets so the
// existing screenshot, Lottie, and icon URLs keep working.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": "/src" } },
  build: { outDir: "dist", emptyOutDir: true },
});
