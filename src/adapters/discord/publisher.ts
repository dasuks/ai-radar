import type { DiscordChannelKey, DiscordDeliveryPayload } from "../../domain/artifacts/discord-edition.js";
import { isValidCalendarDate } from "../../domain/shared/time.js";
import type { Publisher, PublishOutcome } from "../../ports/publishing/index.js";
import type { CheckpointStore } from "../../ports/storage/index.js";
import type { Clock, HttpClient, Logger } from "../../ports/system/index.js";

type Route = { webhookUrl: string; channelId: string };
type Entry = { key: string; channel: DiscordChannelKey; channelId: string; id: string | null; uncertain: boolean; content: string; title: string; summary: string };
type Journal = { guildId: string; date: string; details: Entry[]; summaries: Entry[] };
const sectors = ["models", "coding", "agents", "products", "infra", "evals", "culture"] as const;
const labels = { models: "01 모델·API", coding: "02 코딩 도구·스킬", agents: "03 에이전트 엔지니어링", products: "04 AI 제품 개발", infra: "05 인프라·비용", evals: "06 평가·보안", culture: "07 AI 리터러시" };
const snowflake = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function json(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
function fail(): never { throw new Error("Discord delivery validation failed"); }

export interface DiscordPublisherOptions {
  guildId: string;
  routes: Record<DiscordChannelKey, Route>;
  checkpoints: CheckpointStore;
  clock: Clock;
  http: HttpClient;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

/** A persisted POST intent is deliberately not replayable without reconciliation. */
export class DiscordPublisher implements Publisher {
  readonly channel = "discord" as const;
  constructor(private readonly options: DiscordPublisherOptions) {}

  async publish(input: Parameters<Publisher["publish"]>[0]): Promise<PublishOutcome> {
    try { return await this.deliver(input); }
    catch (error) {
      if (error instanceof DiscordDeliveryError) throw error;
      // Transport, checkpoint and parsing errors may contain credentials. Never propagate them.
      throw new Error("Discord delivery failed; inspect delivery journal before retrying");
    }
  }

  private async deliver(input: Parameters<Publisher["publish"]>[0]): Promise<PublishOutcome> {
    const payload = input.rendered.payload as DiscordDeliveryPayload;
    if (!record(payload) || typeof payload.date !== "string" || !isValidCalendarDate(payload.date) || !Array.isArray(payload.posts)) fail();
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail();
    const seen = new Set<string>();
    for (const post of payload.posts) {
      if (!record(post) || typeof post.key !== "string" || !post.key || seen.has(post.key) || !sectors.includes(post.channel) ||
          typeof post.title !== "string" || !post.title || post.title.length > 100 || typeof post.summary !== "string" || post.summary.length > 180 ||
          typeof post.content !== "string" || !post.content.trim() || post.content.length > 2000) fail();
      seen.add(post.key);
    }
    const urls = this.validatedRoutes();
    const key = `discord:${this.options.guildId}:${payload.date}`;
    if (input.dryRun) {
      this.options.logger?.info("Discord dry-run preview", { date: payload.date, posts: payload.posts.length, preview: input.rendered.preview });
      return { externalId: key, externalUrl: null, action: "skipped" };
    }
    const saved = await this.options.checkpoints.get(key);
    const journal: Journal = saved ? this.readJournal(saved.data, payload.date) : { guildId: this.options.guildId, date: payload.date, details: [], summaries: [] };
    if (saved && saved.schemaVersion !== 1) fail();
    // Validate every configured webhook before any write, even when an edition uses only one route.
    for (const channel of [...sectors, "summary" as const]) {
      const response = await this.options.http.request({ url: urls[channel], method: "GET", timeoutMs: 15_000 });
      const metadata = json(response.text);
      if (response.status !== 200 || !record(metadata) || metadata.guild_id !== this.options.guildId || metadata.channel_id !== this.options.routes[channel].channelId) fail();
    }
    const persist = () => this.options.checkpoints.put(key, { schemaVersion: 1, data: journal }, input.artifactId, this.options.clock.nowIso());
    let failures = 0;
    let changed = false;
    const send = async (entries: Entry[], desired: Entry): Promise<void> => {
      let entry = entries.find((item) => item.key === desired.key);
      if (entry && (entry.channel !== desired.channel || entry.channelId !== desired.channelId)) { failures++; return; }
      if (entry?.uncertain) { failures++; return; }
      if (entry?.id && entry.content === desired.content && entry.title === desired.title && entry.summary === desired.summary) return;
      if (!entry) { entry = desired; entries.push(entry); }
      const existingId = entry.id;
      if (!existingId) { entry.uncertain = true; await persist(); }
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await this.options.http.request({
            url: existingId ? `${urls[desired.channel]}/messages/${existingId}` : `${urls[desired.channel]}?wait=true`,
            method: existingId ? "PATCH" : "POST", timeoutMs: 15_000,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: desired.content, allowed_mentions: { parse: [] } }),
          });
        } catch { failures++; return; }
        if (response.status !== 429) break;
        const body = json(response.text);
        const delay = record(body) ? body.retry_after : null;
        // A 429 definitively created nothing. Persist that fact before waiting.
        if (!existingId) { entry.uncertain = false; await persist(); }
        if (attempt === 2 || typeof delay !== "number" || !Number.isFinite(delay) || delay < 0 || delay > 10) { failures++; return; }
        await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay * 1000);
        if (!existingId) { entry.uncertain = true; await persist(); }
      }
      if (!response || response.status < 200 || response.status >= 300) {
        if (!existingId && response && [400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)) { entry.uncertain = false; await persist(); }
        failures++; return;
      }
      const body = json(response.text);
      if (!record(body) || !snowflake(body.id) || body.channel_id !== desired.channelId || (existingId && body.id !== existingId)) { failures++; return; }
      Object.assign(entry, desired, { id: body.id, uncertain: false });
      await persist();
      changed = true;
    };
    for (const post of payload.posts) {
      await send(journal.details, { key: post.key, channel: post.channel, channelId: this.options.routes[post.channel].channelId,
        id: null, uncertain: false, title: post.title, summary: post.summary, content: post.content });
    }
    const pages = this.summaryPages(journal);
    // If a later edition needs fewer pages, retain message IDs and replace stale pages.
    const pageCount = Math.max(pages.length, journal.summaries.length);
    for (let index = 0; index < pageCount; index++) {
      await send(journal.summaries, { key: `summary:${index}`, channel: "summary", channelId: this.options.routes.summary.channelId,
        id: null, uncertain: false, title: "", summary: "", content: pages[index] ?? `${payload.date} — 요약은 첫 페이지를 확인하세요.` });
    }
    if (failures) throw new DiscordDeliveryError(failures, journal.details.filter((entry) => entry.id).length);
    const first = journal.summaries.find((entry) => entry.id);
    return { externalId: key, externalUrl: first ? this.link(first) : null, action: changed ? (saved ? "updated" : "created") : "skipped" };
  }

  private link(entry: Entry): string { return `https://discord.com/channels/${this.options.guildId}/${entry.channelId}/${entry.id}`; }
  private summaryPages(journal: Journal): string[] {
    const pages: string[] = [];
    let page = `# AI Intelligence Daily · ${journal.date}`;
    let hasItems = false;
    for (const sector of sectors) {
      let headingNeeded = true;
      for (const entry of journal.details.filter((item) => item.channel === sector && item.id)) {
        const title = entry.title.replace(/[\\[\]()*_~`<>]/g, "");
        const heading = `\n\n## ${labels[sector]}`;
        const line = `\n\n[${title}](${this.link(entry)})\n${entry.summary}`;
        if (page.length + (headingNeeded ? heading.length : 0) + line.length > 2000) {
          pages.push(page); page = `# AI Intelligence Daily · ${journal.date} (계속)`; headingNeeded = true;
        }
        page += (headingNeeded ? heading : "") + line;
        headingNeeded = false;
        hasItems = true;
      }
    }
    if (hasItems) pages.push(page);
    return pages;
  }

  private validatedRoutes(): Record<DiscordChannelKey, string> {
    if (!snowflake(this.options.guildId)) fail();
    const result = {} as Record<DiscordChannelKey, string>;
    for (const channel of [...sectors, "summary" as const]) {
      const route = this.options.routes[channel];
      if (!route || !snowflake(route.channelId)) fail();
      const url = new URL(route.webhookUrl);
      if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.port || url.username || url.password || url.search || url.hash ||
          !/^\/api(?:\/v10)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) fail();
      result[channel] = url.toString();
    }
    return result;
  }

  private readJournal(value: unknown, date: string): Journal {
    if (!record(value) || value.guildId !== this.options.guildId || value.date !== date || !Array.isArray(value.details) || !Array.isArray(value.summaries)) fail();
    for (const entries of [value.details, value.summaries]) {
      const keys = new Set<string>();
      for (const entry of entries) {
        if (!record(entry) || typeof entry.key !== "string" || keys.has(entry.key) || ![...sectors, "summary"].includes(String(entry.channel)) ||
            !snowflake(entry.channelId) || (entry.id !== null && !snowflake(entry.id)) || typeof entry.uncertain !== "boolean" ||
            typeof entry.content !== "string" || entry.content.length > 2000 || typeof entry.title !== "string" || entry.title.length > 100 ||
            typeof entry.summary !== "string" || entry.summary.length > 180) fail();
        keys.add(entry.key);
      }
    }
    return value as unknown as Journal;
  }
}

export class DiscordDeliveryError extends Error {
  constructor(readonly failureCount: number, readonly deliveredCount: number) {
    super(`Discord delivery incomplete: ${failureCount} failed, ${deliveredCount} detail posts delivered; inspect journal before retrying`);
    this.name = "DiscordDeliveryError";
  }
}
