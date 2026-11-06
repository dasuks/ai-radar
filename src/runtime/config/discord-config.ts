import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscordChannelKey } from "../../domain/artifacts/discord-edition.js";

export const DISCORD_CHANNEL_KEYS: readonly DiscordChannelKey[] = ["summary", "models", "coding", "agents", "products", "infra", "evals", "culture"];
export interface DiscordConfig {
  guildId: string;
  audience: "members";
  routes: Record<DiscordChannelKey, { webhookUrl: string; channelId: string }>;
}

/** Only runtime/config reads local configuration. Never interpolate secret values into errors. */
export function loadDiscordConfig(storeDir: string): DiscordConfig | null {
  const file = join(storeDir, "discord-webhooks.json");
  if (!existsSync(file)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
  catch { throw new Error("Discord configuration is not valid JSON"); }
  if (!raw || typeof raw !== "object") throw new Error("Discord configuration must be an object");
  const value = raw as Record<string, unknown>;
  if (value.enabled === false) return null;
  if (value.enabled !== true || value.audience !== "members" || typeof value.guildId !== "string" || !/^\d{16,22}$/.test(value.guildId)) {
    throw new Error("Discord requires enabled=true, audience=members and a valid guildId");
  }
  const routes = value.routes as Record<string, unknown> | undefined;
  const result = {} as DiscordConfig["routes"];
  const ids = new Set<string>();
  for (const key of DISCORD_CHANNEL_KEYS) {
    const route = routes?.[key] as Record<string, unknown> | undefined;
    if (!route || typeof route.channelId !== "string" || !/^\d{16,22}$/.test(route.channelId)
      || typeof route.webhookUrl !== "string" || !/^https:\/\/discord\.com\/api(?:\/v10)?\/webhooks\/\d{16,22}\/[A-Za-z0-9_-]+$/.test(route.webhookUrl)) {
      throw new Error(`Discord channel ${key} needs a valid channelId and official webhook URL`);
    }
    if (ids.has(route.channelId)) throw new Error("Discord channels must have distinct channel IDs");
    ids.add(route.channelId);
    result[key] = { channelId: route.channelId, webhookUrl: route.webhookUrl };
  }
  return { guildId: value.guildId, audience: "members", routes: result };
}

export function discordSecrets(config: DiscordConfig | null): string[] {
  return config ? Object.values(config.routes).flatMap((r) => [r.webhookUrl, r.webhookUrl.split("/").at(-1)!]) : [];
}
