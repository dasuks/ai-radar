import type { Artifact, PublicationRecord } from "../../domain/artifacts/artifact.js";
import { contentHashOf } from "../../domain/artifacts/artifact.js";
import type { DiscordEditionBody } from "../../domain/artifacts/discord-edition.js";
import { artifactId } from "../../domain/shared/ids.js";
import { BuildDiscordEdition, discordEditorialCacheHash, DISCORD_EDITORIAL_VERSION } from "./build-discord-edition.js";
import { publishArtifact } from "../publish/publish-artifact.js";
import type { DailyPipelineDeps, PipelineStage } from "../runs/run-daily-pipeline.js";
import type { LlmProvider } from "../../ports/llm/llm-provider.js";
import type { Publisher, Renderer } from "../../ports/publishing/index.js";
import type { Stores } from "../../ports/storage/index.js";
import type { Clock, Logger } from "../../ports/system/index.js";

/** Standalone review requires neither configured destinations nor persistent stores. */
export function previewDiscordEdition(body: DiscordEditionBody, renderer: Renderer<DiscordEditionBody>, clock: Clock, timezone: string): string {
  return renderer.render({
    schemaVersion: 1, id: artifactId("DISCORD_EDITION", body.date), type: "DISCORD_EDITION", targetKey: body.date,
    revision: 1, contentHash: contentHashOf(body), status: "DRAFT", timezone,
    window: { start: clock.nowIso(), end: clock.nowIso() }, body,
    inputs: { claimIds: [], documentIds: [], signalRefs: [], rankingPolicies: [], runId: "preview" },
    visibility: "PRIVATE", createdAt: clock.nowIso(),
  }).preview;
}

export async function publishDiscordEdition(input: {
  body: DiscordEditionBody; stores: Stores; clock: Clock; publisher: Publisher; logger: Logger;
  runId: string; dryRun: boolean; timezone: string; window: { start: string; end: string };
  sourceHash?: string; sourceInputs?: Artifact<unknown>["inputs"]; renderer: Renderer<DiscordEditionBody>;
}): Promise<PublicationRecord> {
  const { body, stores, clock } = input;
  const head = await stores.artifacts.head("DISCORD_EDITION", body.date);
  const artifact: Artifact<DiscordEditionBody> = {
    schemaVersion: 1, id: artifactId("DISCORD_EDITION", body.date), type: "DISCORD_EDITION", targetKey: body.date,
    revision: (head?.revision ?? 0) + 1, contentHash: contentHashOf(body), status: "FINAL", timezone: input.timezone,
    window: input.window, body, inputs: { claimIds: [...(input.sourceInputs?.claimIds ?? [])], documentIds: [...(input.sourceInputs?.documentIds ?? [])],
      signalRefs: [...(input.sourceInputs?.signalRefs ?? [])],
      rankingPolicies: [...(input.sourceInputs?.rankingPolicies ?? []), { id: `discord.editorial.v${DISCORD_EDITORIAL_VERSION}`, version: input.sourceHash ?? "manual" }], runId: input.runId },
    visibility: "PRIVATE", createdAt: clock.nowIso(),
  };
  if (!input.dryRun) {
    const saved = await stores.artifacts.putRevision(artifact);
    artifact.revision = saved.revision;
  }
  return publishArtifact({ artifact, channel: "discord", renderer: input.renderer, publisher: input.publisher,
    artifactStore: stores.artifacts, runId: input.runId, dryRun: input.dryRun, clock, logger: input.logger });
}

export function discordStage(input: {
  pipeline: DailyPipelineDeps; stores: Stores; llm: LlmProvider; model: string;
  allowedSourceIds?: readonly string[];
  publisher: Publisher; clock: Clock; logger: Logger; renderer: Renderer<DiscordEditionBody>;
}): PipelineStage {
  return {
    name: "publish:discord", enabled: (ctx) => input.pipeline.source.kind === "auto" && ctx.artifact !== null,
    async run(ctx) {
      const brief = ctx.artifact!;
      try {
        const head = await input.stores.artifacts.head("DISCORD_EDITION", ctx.date);
        const cached = head ? await input.stores.artifacts.get<DiscordEditionBody>("DISCORD_EDITION", ctx.date, head.revision) : null;
        const builder = new BuildDiscordEdition({ llm: input.llm, model: input.model, stores: input.stores,
          ...(input.allowedSourceIds ? { allowedSourceIds: input.allowedSourceIds } : {}),
          onUsage: async (response) => input.pipeline.recorder.addLlmUsage([{ provider: response.provider, model: response.model,
            inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, costUsd: response.usage.costUsd }]) });
        const candidates = await builder.prepare(brief.body);
        const sourceHash = discordEditorialCacheHash(brief.contentHash, input.model, candidates);
        const matching = cached?.inputs.rankingPolicies.some((p) => p.id === `discord.editorial.v${DISCORD_EDITORIAL_VERSION}` && p.version === sourceHash);
        const body = matching && cached ? cached.body : await builder.execute(brief.body, undefined, candidates);
        const record = await publishDiscordEdition({ body, stores: input.stores, publisher: input.publisher, clock: input.clock,
          logger: input.logger, runId: ctx.runId, dryRun: ctx.dryRun, timezone: ctx.timezone, window: ctx.window, sourceHash,
          sourceInputs: brief.inputs, renderer: input.renderer });
        ctx.publications.push(record);
        await input.pipeline.recorder.updateCounters((c) => { c.publications.push(`discord:${record.status}`); });
        if (record.status !== "SUCCEEDED") throw new Error(record.error ?? "Discord delivery incomplete");
      } catch (error) {
        if (!ctx.publications.some((p) => p.channel === "discord")) ctx.publications.push({
          artifactId: artifactId("DISCORD_EDITION", ctx.date), revision: 0, channel: "discord", externalId: null, externalUrl: null,
          status: "FAILED", attempt: 1, renderedHash: "", scheduledAt: null, publishedAt: null,
          error: "Discord edition could not be built or delivered", runId: ctx.runId,
        });
        throw error;
      }
    },
  };
}
