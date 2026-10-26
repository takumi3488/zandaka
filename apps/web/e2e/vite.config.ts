import { fileURLToPath } from "node:url";

import appViteConfig from "../vite.config";
import { defineConfig, type Plugin, type PluginOption, type UserConfig } from "vite";

import { E2E_BASE_URL } from "./constants";

const pwaRegistrationModuleId = "\0e2e-pwa-register";
const disablePwaRegistration: Plugin = {
  name: "e2e-disable-pwa-registration",
  enforce: "pre",
  resolveId(id) {
    if (id === "virtual:pwa-register") {
      return pwaRegistrationModuleId;
    }
  },
  load(id) {
    if (id === pwaRegistrationModuleId) {
      return "export function registerSW() { return Promise.resolve(); }";
    }
  },
};

async function resolvePlugins(options: PluginOption[]): Promise<Plugin[]> {
  const pending = [...options].reverse();
  const plugins: Plugin[] = [];

  while (pending.length > 0) {
    const option = await pending.pop();
    if (!option) continue;

    if (Array.isArray(option)) {
      for (let index = option.length - 1; index >= 0; index--) {
        pending.push(option[index]);
      }
    } else if (!option.name.startsWith("vite-plugin-pwa")) {
      plugins.push(option);
    }
  }

  return plugins;
}

export default defineConfig(async (configEnv): Promise<UserConfig> => {
  const appConfig =
    typeof appViteConfig === "function" ? await appViteConfig(configEnv) : appViteConfig;
  const url = new URL(E2E_BASE_URL);
  const plugins = await resolvePlugins(appConfig.plugins ?? []);

  return {
    ...appConfig,
    plugins: [...plugins, disablePwaRegistration],
    cacheDir: fileURLToPath(new URL("../node_modules/.vite-e2e", import.meta.url)),
    envDir: false,
    envPrefix: [],
    resolve: {
      ...appConfig.resolve,
      alias: {
        "cloudflare:workers": fileURLToPath(new URL("./cloudflare-workers.ts", import.meta.url)),
      },
    },
    server: {
      ...appConfig.server,
      host: url.hostname,
      port: Number(url.port),
      strictPort: true,
    },
  };
});
