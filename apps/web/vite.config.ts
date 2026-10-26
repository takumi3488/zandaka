import { fileURLToPath } from "node:url";

import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { fileRoutes } from "filesystem-routing/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ command }) => {
  const cloudflareWorkersAlias: Record<string, string> =
    command === "serve" && process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED !== "1"
      ? {
          "cloudflare:workers": fileURLToPath(
            new URL("./cloudflare-workers.dev.ts", import.meta.url),
          ),
        }
      : {};

  return {
    optimizeDeps: {
      entries: ["src/**/*.tsx"],
    },
    plugins: [
      solid({
        start: { middleware: "./src/middleware.ts" },
        ssr: true,
        extensions: [".jsx", ".tsx"],
      }),
      fileRoutes({ httpMethods: true }),
      tailwindcss(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: null,
        includeAssets: ["offline.html"],
        integration: {
          closeBundleOrder: "post",
          configureOptions(viteConfig, options) {
            const outDir = viteConfig.environments.client.build.outDir;
            options.outDir = outDir;
            options.pwaAssets = { ...options.pwaAssets, integration: { outDir } };
          },
        },
        workbox: {
          navigateFallback: null,
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.mode === "navigate",
              handler: "NetworkOnly",
              options: { precacheFallback: { fallbackURL: "offline.html" } },
            },
          ],
          globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        },
        manifest: {
          name: "共有資金の出納帳",
          short_name: "zandaka",
          description: "共有URLで資金の入出金を管理する出納帳",
          theme_color: "#F2F6FC",
        },
        pwaAssets: { disabled: false, config: true },
        devOptions: { enabled: true },
      }).map((plugin) => {
        // Service workers belong to the client build. SSR/server builds must not
        // regenerate them after the server has recorded public asset metadata.
        plugin.applyToEnvironment = (environment) => environment.name === "client";
        return plugin;
      }),
    ],
    server: {
      port: 3001,
    },
    build: {
      rollupOptions: {
        external: ["cloudflare:workers"],
      },
    },
    ssr: {
      noExternal: ["solid-js", /^@solidjs\//, "@tanstack/solid-query"],
    },
    resolve: {
      tsconfigPaths: true,
      alias: cloudflareWorkersAlias,
    },
  };
});
