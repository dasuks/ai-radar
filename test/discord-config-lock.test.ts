import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiscordConfig, DISCORD_CHANNEL_KEYS, discordSecrets } from "../src/runtime/config/discord-config.js";
import { withDiscordLock } from "../src/runtime/runs/discord-lock.js";

test("Discord configuration is opt-in, member-scoped, destination-distinct and secret-safe", () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-discord-config-"));
  try {
    assert.equal(loadDiscordConfig(dir), null);
    const routes = Object.fromEntries(DISCORD_CHANNEL_KEYS.map((key, i) => [key, {
      channelId: `155384785559539725${i}`, webhookUrl: `https://discord.com/api/webhooks/155384785559539725${i}/test-secret`,
    }]));
    const config = { enabled: false, audience: "members", guildId: "1553831664856334488", routes };
    const save = () => writeFileSync(join(dir, "discord-webhooks.json"), JSON.stringify(config));
    save(); assert.equal(loadDiscordConfig(dir), null);
    config.enabled = true; save(); assert.equal(Object.keys(loadDiscordConfig(dir)!.routes).length, 8);
    assert.ok(discordSecrets(loadDiscordConfig(dir)).includes("test-secret"));
    config.audience = "public"; save(); assert.throws(() => loadDiscordConfig(dir), /members/);
    config.audience = "members";
    routes.models!.channelId = routes.summary!.channelId; save(); assert.throws(() => loadDiscordConfig(dir), /distinct/);
    routes.models!.channelId = "1553847855595397251";
    routes.models!.webhookUrl = "https://example.com/test-secret"; save();
    assert.throws(() => loadDiscordConfig(dir), (error: Error) => !error.message.includes("test-secret"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Discord lock excludes a second writer, releases on failure and never steals stale locks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-discord-lock-"));
  try {
    await withDiscordLock(dir, async () => {
      await assert.rejects(withDiscordLock(dir, async () => assert.fail("second writer entered")), /lock/);
    });
    assert.equal(existsSync(join(dir, "discord-send.lock")), false);
    await assert.rejects(withDiscordLock(dir, async () => { throw new Error("expected"); }), /expected/);
    assert.equal(existsSync(join(dir, "discord-send.lock")), false);
    writeFileSync(join(dir, "discord-send.lock"), "99999999");
    await assert.rejects(withDiscordLock(dir, async () => assert.fail("stale lock stolen")), /Inspect/);
    assert.equal(existsSync(join(dir, "discord-send.lock")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
