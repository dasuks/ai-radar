import {
  CHANNEL_POLICY,
  type ApprovalRecord,
  type Artifact,
  type ChannelId,
  type PublicationRecord,
} from "../../domain/artifacts/artifact.js";
import type { Publisher, Renderer } from "../../ports/publishing/index.js";
import type { ArtifactStore } from "../../ports/storage/index.js";
import type { Clock, Logger } from "../../ports/system/index.js";

export interface PublishArtifactInput<TBody> {
  artifact: Artifact<TBody>;
  channel: ChannelId;
  renderer: Renderer<TBody>;
  publisher: Publisher;
  artifactStore: ArtifactStore;
  runId: string;
  dryRun: boolean;
  clock: Clock;
  logger?: Logger;
}

function baseRecord(
  input: Pick<PublishArtifactInput<unknown>, "artifact" | "channel" | "runId">,
  attempt: number,
  renderedHash: string,
  externalId: string | null,
): PublicationRecord {
  return {
    artifactId: input.artifact.id,
    revision: input.artifact.revision,
    channel: input.channel,
    externalId,
    externalUrl: null,
    status: "PENDING",
    attempt,
    renderedHash,
    scheduledAt: null,
    publishedAt: null,
    error: null,
    runId: input.runId,
  };
}

/**
 * PublishArtifact (PIPELINES_AND_POLICIES.md §9).
 *
 * - PRIVATE artifact 는 `allowsPrivate=false` 채널로 나가지 않는다.
 * - PRIVATE 채널은 POLICY 자동 승인, PUBLIC 채널은 ApprovalRecord 없이 발행하지 않는다.
 * - 같은 revision 이 이미 SUCCEEDED 면 건너뛴다 (idempotent).
 * - 직전 publication 의 `externalId` 를 이어받아 같은 외부 객체를 갱신한다 (중복 생성 금지).
 * - 채널 실패는 throw 하지 않고 FAILED 기록으로 돌려준다 (다른 채널을 막지 않기 위해).
 */
export async function publishArtifact<TBody>(input: PublishArtifactInput<TBody>): Promise<PublicationRecord> {
  const { artifact, channel, artifactStore, clock } = input;
  const policy = CHANNEL_POLICY[channel];
  const latest = await artifactStore.latestPublication(artifact.id, channel);
  const attempt = (latest?.attempt ?? 0) + 1;
  const carriedExternalId = latest?.externalId ?? null;

  const refuse = async (message: string, status: PublicationRecord["status"]): Promise<PublicationRecord> => {
    const record: PublicationRecord = {
      ...baseRecord(input, attempt, "", carriedExternalId),
      status,
      error: message,
    };
    input.logger?.warn(message, { channel, artifactId: artifact.id });
    if (!input.dryRun) await artifactStore.putPublication(record);
    return record;
  };

  if (artifact.visibility === "PRIVATE" && !policy.allowsPrivate) {
    return refuse(
      `channel ${channel} does not accept PRIVATE artifacts; mark the artifact PUBLIC_OK first`,
      "FAILED",
    );
  }

  if (policy.approval === "USER") {
    const approval = await artifactStore.approval(artifact.id, artifact.revision, channel);
    if (!approval) {
      return refuse(`channel ${channel} requires a user approval for revision ${artifact.revision}`, "PENDING_APPROVAL");
    }
    if (approval.contentHash !== artifact.contentHash) {
      return refuse(`approval for ${channel} was issued for a different contentHash; re-approve the current revision`, "FAILED");
    }
  } else if (!input.dryRun) {
    const existing = await artifactStore.approval(artifact.id, artifact.revision, channel);
    if (!existing) {
      const approval: ApprovalRecord = {
        artifactId: artifact.id,
        revision: artifact.revision,
        contentHash: artifact.contentHash,
        renderedAssetHash: null,
        channel,
        approvedBy: "POLICY",
        approvedAt: clock.nowIso(),
        note: null,
      };
      await artifactStore.putApproval(approval);
    }
  }

  if (latest && latest.revision === artifact.revision && latest.status === "SUCCEEDED") {
    input.logger?.info(`revision ${artifact.revision} already published to ${channel}; skipping`, {
      externalId: latest.externalId,
    });
    return latest;
  }

  const rendered = input.renderer.render(artifact);
  const pending = baseRecord(input, attempt, rendered.hash, carriedExternalId);
  if (!input.dryRun) await artifactStore.putPublication(pending);

  try {
    const outcome = await input.publisher.publish({
      artifactId: artifact.id,
      revision: artifact.revision,
      rendered,
      existingExternalId: carriedExternalId,
      dryRun: input.dryRun,
    });
    const record: PublicationRecord = {
      ...pending,
      status: "SUCCEEDED",
      externalId: outcome.externalId ?? carriedExternalId,
      externalUrl: outcome.externalUrl,
      publishedAt: clock.nowIso(),
    };
    if (!input.dryRun) await artifactStore.putPublication(record);
    input.logger?.info(`${channel} ${outcome.action}`, { externalId: record.externalId });
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record: PublicationRecord = { ...pending, status: "FAILED", error: message };
    if (!input.dryRun) await artifactStore.putPublication(record);
    input.logger?.error(`${channel} publication failed: ${message}`);
    return record;
  }
}
