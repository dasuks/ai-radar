import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_OBSIDIAN_VAULT = "C:\\dev\\knowledge\\ai-knowledge";

export interface AppPaths {
  projectRoot: string;
  inputFile: string;
  vaultRoot: string;
  dailyDirectory: string;
}

export function getAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const vaultRoot = resolve(env.OBSIDIAN_VAULT_PATH || DEFAULT_OBSIDIAN_VAULT);
  return {
    projectRoot: PROJECT_ROOT,
    inputFile: resolve(PROJECT_ROOT, "data", "daily-brief.json"),
    vaultRoot,
    dailyDirectory: resolve(vaultRoot, "99 Daily"),
  };
}
