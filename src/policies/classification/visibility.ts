/**
 * Claim visibility 규칙 (CONTRACTS_AND_DATA.md §5.4).
 * 기본은 PRIVATE. 공개 공식/블로그 호스트에서 나온 FACT/OFFICIAL_CLAIM 만 PUBLIC_OK 다.
 * 순수 함수만 둔다 (policies 계층).
 */
import type { ClaimType, Visibility } from "../../domain/evidence/claim.js";

export const VISIBILITY_POLICY_ID = "classification.visibility";
export const VISIBILITY_POLICY_VERSION = "1.0.0";

/** 공식 발표·공개 기술 블로그 호스트. 하위 도메인도 허용한다. changelog: v1.0.0 최초 목록. */
export const PUBLIC_HOST_ALLOWLIST: readonly string[] = [
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "blog.google",
  "developers.googleblog.com",
  "ai.meta.com",
  "engineering.fb.com",
  "microsoft.com",
  "azure.microsoft.com",
  "github.blog",
  "github.com",
  "huggingface.co",
  "arxiv.org",
  "mistral.ai",
  "cohere.com",
  "stability.ai",
  "together.ai",
  "databricks.com",
  "nvidia.com",
  "developer.nvidia.com",
  "aws.amazon.com",
  "cloudflare.com",
  "vercel.com",
  "netflixtechblog.com",
  "simonwillison.net",
];

const PUBLIC_CLAIM_TYPES: readonly ClaimType[] = ["FACT", "OFFICIAL_CLAIM"];

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isPublicHost(host: string | null): boolean {
  if (!host) return false;
  const normalized = host.startsWith("www.") ? host.slice(4) : host;
  return PUBLIC_HOST_ALLOWLIST.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`));
}

export interface VisibilityInput {
  /** 근거 문서의 canonicalUrl (없으면 첫 url) */
  documentUrl: string | null;
  claimType: ClaimType;
}

export interface VisibilityDecision {
  visibility: Visibility;
  reason: string;
}

export function decideVisibilityWithReason(input: VisibilityInput): VisibilityDecision {
  const host = hostOf(input.documentUrl);
  if (!isPublicHost(host)) {
    return { visibility: "PRIVATE", reason: host ? `host ${host} is not in the public allowlist` : "no public source url" };
  }
  if (!PUBLIC_CLAIM_TYPES.includes(input.claimType)) {
    return { visibility: "PRIVATE", reason: `claim type ${input.claimType} is not publishable` };
  }
  return { visibility: "PUBLIC_OK", reason: `public host ${host ?? ""} and claim type ${input.claimType}` };
}

export function decideVisibility(input: VisibilityInput): Visibility {
  return decideVisibilityWithReason(input).visibility;
}
