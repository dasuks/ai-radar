import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiscordEdition } from "../../domain/artifacts/discord-edition.js";
import { openSqliteStores } from "../../adapters/storage/sqlite/index.js";
import { FetchHttpClient } from "../../adapters/system/http-client.js";
import { ConsoleLogger, redactText } from "../../adapters/system/logger.js";
import { SystemClock } from "../../adapters/system/clock.js";
import { loadConfig } from "../config/app-config.js";
import { discordPublisher } from "../composition/discord-wiring.js";
import { previewDiscordEdition, publishDiscordEdition } from "../../application/discord/publish-discord-edition.js";
import { DiscordEditionRenderer } from "../../adapters/rendering/discord/edition-renderer.js";
import { withDiscordLock } from "../runs/discord-lock.js";
import { JsonRunRecorder } from "../runs/run-recorder.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let secrets: string[] = [];
  try {
    if (argv.includes("--help")) { console.log("npm run discord -- --input <edition.json> [--dry-run]"); return 0; }
    let input: string | null = null;
    let dryRun = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--dry-run") dryRun = true;
      else if (argv[i] === "--input" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) input = argv[++i]!;
      else throw new Error("Expected --input <edition.json> and optional --dry-run");
    }
    if (!input) throw new Error("--input <edition.json> is required");
    const config = loadConfig(undefined, { requireNotion: false });
    secrets = config.redaction;
    const body = parseDiscordEdition(JSON.parse(readFileSync(resolve(input), "utf8")));
    const clock = new SystemClock();
    if (dryRun) {
      console.log(previewDiscordEdition(body, new DiscordEditionRenderer(), clock, config.timezone));
      console.log("Discord preview (dry-run)");
      return 0;
    }
    if (!config.discord) throw new Error("Discord is not enabled in data/store/discord-webhooks.json");
    const logger = new ConsoleLogger({ redact: secrets });
    const stores = openSqliteStores({ dir: config.store.dir, rawPayloadRoot: config.store.dir });
    try {
      const publisher = discordPublisher(config.discord, stores, clock, new FetchHttpClient(), logger);
      const run = async () => {
        const window = { start: clock.nowIso(), end: clock.nowIso() };
        const recorder = dryRun ? null : await JsonRunRecorder.start({ store: stores.runs, clock, kind: "PUBLISH_ONLY",
          window, timezone: config.timezone, stages: ["publish:discord"] });
        await recorder?.begin("publish:discord");
        try {
          const result = await publishDiscordEdition({ body, renderer: new DiscordEditionRenderer(), stores, clock, publisher, logger,
            runId: recorder?.runId ?? `discord-preview-${clock.nowMs()}`, dryRun, timezone: config.timezone, window });
          await recorder?.updateCounters((counters) => {
            counters.artifactsCreated.push(result.artifactId);
            counters.publications.push(`discord:${result.status}`);
          });
          if (result.status !== "SUCCEEDED") await recorder?.addError({ stage: "publish:discord", message: result.error ?? "Discord delivery incomplete", retryable: true });
          await recorder?.end("publish:discord", result.status === "SUCCEEDED" ? "DONE" : "FAILED");
          await recorder?.finish(result.status === "SUCCEEDED" ? "SUCCESS" : "OUTPUT_FAILURE");
          return result;
        } catch (error) {
          await recorder?.addError({ stage: "publish:discord", message: "Discord edition could not be built or delivered", retryable: false });
          await recorder?.end("publish:discord", "FAILED");
          await recorder?.finish("OUTPUT_FAILURE");
          throw error;
        }
      };
      const result = dryRun ? await run() : await withDiscordLock(config.store.dir, run);
      console.log(`Discord ${result.status}${dryRun ? " (dry-run)" : ""}${result.externalUrl ? ` ${result.externalUrl}` : ""}`);
      return result.status === "SUCCEEDED" ? 0 : 1;
    } finally { stores.close(); }
  } catch (error) {
    console.error(redactText(error instanceof Error ? error.message : "Discord command failed", secrets));
    return 1;
  }
}

const entry = process.argv[1];
if (entry && realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }, () => { console.error("Discord command failed"); process.exitCode = 1; });
}
