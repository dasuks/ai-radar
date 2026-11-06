import type { Publisher } from "../../ports/publishing/index.js";
import type { Stores } from "../../ports/storage/index.js";
import type { Clock, HttpClient, Logger } from "../../ports/system/index.js";
import { DiscordPublisher } from "../../adapters/discord/publisher.js";
import type { DiscordConfig } from "../config/discord-config.js";

export function discordPublisher(config: DiscordConfig, stores: Stores, clock: Clock, http: HttpClient, logger: Logger): Publisher {
  return new DiscordPublisher({ ...config, checkpoints: stores.checkpoints, clock, http, logger });
}
