import type { DerivedSignalRef } from "../metrics/derived-signal.js";
import type { Visibility } from "../evidence/claim.js";
import { canonicalJson, sha256Hex } from "../shared/ids.js";

export const ARTIFACT_TYPES = [
  "DAILY_BRIEF",
  "WEEKLY_REPORT",
  "TREND_REPORT",
  "ALERT",
  "KNOWLEDGE_PROPOSAL",
  "SOCIAL_POST_DRAFT",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export type ArtifactStatus = "DRAFT" | "FINAL" | "APPROVED" | "PUBLISHED" | "RETRACTED";

export type ChannelId = "notion" | "obsidian" | "discord" | "email" | "instagram" | "web";

/** CONTRACTS_AND_DATA.md §5.1 */
export interface Artifact<TBody> {
  schemaVersion: 1;
  id: string;
  type: ArtifactType;
  targetKey: string;
  revision: number;
  contentHash: string;
  status: ArtifactStatus;
  timezone: string;
  window: { start: string; end: string };
  body: TBody;
  inputs: {
    claimIds: string[];
    documentIds: string[];
    signalRefs: DerivedSignalRef[];
    rankingPolicies: { id: string; version: string }[];
    runId: string;
  };
  visibility: Visibility;
  createdAt: string;
}

export type ArtifactRevision<T> = Artifact<T>;
export interface ArtifactHead {
  type: ArtifactType;
  targetKey: string;
  revision: number;
}

export function contentHashOf(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

/** CONTRACTS_AND_DATA.md §5.3 */
export interface ApprovalRecord {
  artifactId: string;
  revision: number;
  contentHash: string;
  renderedAssetHash: string | null;
  channel: ChannelId;
  approvedBy: "USER" | "POLICY";
  approvedAt: string;
  note: string | null;
}

export type PublicationStatus = "PENDING_APPROVAL" | "PENDING" | "SUCCEEDED" | "FAILED" | "RETRACTED";

export interface PublicationRecord {
  artifactId: string;
  revision: number;
  channel: ChannelId;
  externalId: string | null;
  externalUrl: string | null;
  status: PublicationStatus;
  attempt: number;
  renderedHash: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  error: string | null;
  runId: string;
}

/** 채널 정책 (INTEGRATIONS_AND_SAFETY.md §6.2) */
export const CHANNEL_POLICY: Record<ChannelId, { allowsPrivate: boolean; approval: "POLICY" | "USER" }> = {
  notion: { allowsPrivate: true, approval: "POLICY" },
  obsidian: { allowsPrivate: true, approval: "POLICY" },
  discord: { allowsPrivate: true, approval: "POLICY" },
  email: { allowsPrivate: true, approval: "POLICY" },
  instagram: { allowsPrivate: false, approval: "USER" },
  web: { allowsPrivate: false, approval: "USER" },
};
