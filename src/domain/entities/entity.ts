import type { Provenance } from "../evidence/provenance.js";

export const ENTITY_TYPES = [
  "MODEL",
  "TOOL",
  "SKILL",
  "MCP_SERVER",
  "FRAMEWORK",
  "REPOSITORY",
  "COMPANY",
  "PERSON",
  "CONCEPT",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** CONTRACTS_AND_DATA.md §2.1 */
export interface Entity {
  schemaVersion: 1;
  id: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  officialUrl: string | null;
  repositoryUrl: string | null;
  ecosystem: string | null;
  parentEntityId: string | null;
  versionLabel: string | null;
  identityConfidence: number;
  status: "ACTIVE" | "MERGED" | "RETIRED";
  mergedIntoId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntityMention {
  documentId: string;
  entityId: string | null;
  surfaceForm: string;
  resolution: "RESOLVED" | "CANDIDATE" | "UNRESOLVED";
  candidateEntityIds: string[];
  confidence: number;
  locatorKey: string;
  provenance: Provenance;
}

/** 정규화 이름: NFKC, 소문자, 하이픈/언더스코어 → 공백, 연속 공백 축약 */
export function normalizeEntityName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

/** github.com/owner/repo 정규형. 아니면 null. */
export function normalizeRepositoryUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (!match) return null;
  return `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
}
