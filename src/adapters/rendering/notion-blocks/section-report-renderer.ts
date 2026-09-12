import type { BlockObjectRequest } from "@notionhq/client";
import type { Artifact } from "../../../domain/artifacts/artifact.js";
import { SECTION_TITLES_KO, type SourceRef } from "../../../domain/artifacts/daily-brief.js";
import type {
  EvidenceQuote,
  ExcludedStory,
  ReportEntry,
  SectionReportBody,
} from "../../../domain/artifacts/section-report.js";
import type { ClaimType } from "../../../domain/evidence/claim.js";
import type { ContentCompleteness } from "../../../domain/documents/raw-observation.js";
import { canonicalJson, sha256Hex } from "../../../domain/shared/ids.js";
import type { Rendered, Renderer } from "../../../ports/publishing/index.js";
import {
  divider,
  linkedListItem,
  revisionCallout,
  safeLinkUrl,
  textBlocks,
  titleRichText,
  type NotionPageProperties,
  type NotionReportRenderedPayload,
} from "./blocks.js";

/** 근거 수준 표기 (사용자는 "본문을 읽고 쓴 글인지"를 알아야 한다). */
export const EVIDENCE_LEVEL_LABELS_KO: Record<ContentCompleteness, string> = {
  FULL: "본문 있음",
  EXCERPT: "요약문",
  TITLE_ONLY: "제목만",
  MISSING: "본문 없음",
};

/** 주장 구분 표기. domain 의 ClaimType 을 한국어 라벨로만 바꾼다. */
export const CLAIM_TYPE_LABELS_KO: Record<ClaimType, string> = {
  FACT: "사실",
  OFFICIAL_CLAIM: "공식 주장",
  USER_EXPERIENCE: "사용자 경험",
  OPINION: "의견",
  FORECAST: "전망",
  RUMOR: "루머",
  SYSTEM_INFERENCE: "시스템 추론",
};

function sourceBlocks(source: SourceRef): BlockObjectRequest[] {
  return linkedListItem(source.title, source.url);
}

function quoteBlocks(quote: EvidenceQuote): BlockObjectRequest[] {
  const attribution = quote.author?.trim() ? quote.author.trim() : "출처";
  const blocks = textBlocks("quote", `"${quote.text}" — ${attribution}`);
  const url = safeLinkUrl(quote.url);
  if (url) blocks.push(...textBlocks("paragraph", "원문 링크 →", url));
  return blocks;
}

function excludedBlocks(story: ExcludedStory): BlockObjectRequest[] {
  const url = safeLinkUrl(story.url);
  const blocks = textBlocks("bulleted_list_item", `${story.title} — ${story.reason}`, url);
  if (!url && story.url) blocks.push(...textBlocks("paragraph", story.url));
  return blocks;
}

function entryBlocks(entry: ReportEntry): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [
    divider(),
    ...textBlocks("heading_2", entry.title),
    ...textBlocks(
      "paragraph",
      `중요도 ${entry.importance}/5 · 근거 수준 ${EVIDENCE_LEVEL_LABELS_KO[entry.evidenceLevel]}`,
    ),
    ...textBlocks("heading_3", "무슨 일이 있었나"),
  ];
  if (entry.narrative.length === 0) blocks.push(...textBlocks("paragraph", "작성된 내용이 없습니다."));
  else for (const paragraph of entry.narrative) blocks.push(...textBlocks("paragraph", paragraph));

  blocks.push(...textBlocks("heading_3", "근거 인용"));
  if (entry.evidenceQuotes.length === 0) blocks.push(...textBlocks("paragraph", "인용할 근거가 없습니다."));
  else for (const quote of entry.evidenceQuotes) blocks.push(...quoteBlocks(quote));

  blocks.push(...textBlocks("heading_3", "주장 구분"));
  if (entry.claims.length === 0) blocks.push(...textBlocks("paragraph", "분류된 주장이 없습니다."));
  else
    for (const claim of entry.claims) {
      blocks.push(...textBlocks("bulleted_list_item", `[${CLAIM_TYPE_LABELS_KO[claim.type]}] ${claim.statement}`));
    }

  if (entry.communityReaction) {
    blocks.push(...textBlocks("heading_3", "커뮤니티 반응"), ...textBlocks("paragraph", entry.communityReaction));
  }

  blocks.push(...textBlocks("heading_3", "관련 회사·도구"));
  if (entry.entities.length === 0) blocks.push(...textBlocks("paragraph", "등록된 대상이 없습니다."));
  else
    for (const entity of entry.entities) {
      blocks.push(...textBlocks("bulleted_list_item", entity.type ? `${entity.name} (${entity.type})` : entity.name));
    }

  blocks.push(...textBlocks("heading_3", "왜 중요한가"), ...textBlocks("paragraph", entry.whyItMatters));

  if (entry.howToApply) {
    blocks.push(...textBlocks("heading_3", "내 환경에 적용하려면"), ...textBlocks("paragraph", entry.howToApply));
  }

  blocks.push(...textBlocks("heading_3", "반론과 불확실한 점"));
  const doubts = [...entry.counterpoints, ...entry.openQuestions];
  if (doubts.length === 0) blocks.push(...textBlocks("paragraph", "기록된 반론이 없습니다."));
  else for (const doubt of doubts) blocks.push(...textBlocks("bulleted_list_item", doubt));

  blocks.push(...textBlocks("heading_3", "Sources"));
  if (entry.sourceRefs.length === 0) blocks.push(...textBlocks("paragraph", "등록된 출처가 없습니다."));
  else for (const source of entry.sourceRefs) blocks.push(...sourceBlocks(source));

  return blocks;
}

export function buildSectionReportBlocks(body: SectionReportBody, revision: number): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [revisionCallout(revision)];

  const failed = body.coverage.sourcesFailed;
  if (failed.length > 0) blocks.push(...textBlocks("paragraph", `수집 실패: ${failed.join(", ")}`));
  else if (body.coverage.partial) blocks.push(...textBlocks("paragraph", "수집 범위가 일부만 확인되었습니다."));
  if (body.coverage.note) blocks.push(...textBlocks("paragraph", body.coverage.note));

  blocks.push(...textBlocks("heading_1", "오늘 이 분야 한눈에"));
  if (body.overview.length === 0) blocks.push(...textBlocks("paragraph", "등록된 요약이 없습니다."));
  else for (const line of body.overview) blocks.push(...textBlocks("bulleted_list_item", line));

  for (const entry of body.entries) blocks.push(...entryBlocks(entry));

  blocks.push(...textBlocks("heading_1", "이 분야 출처"));
  if (body.sources.length === 0) blocks.push(...textBlocks("paragraph", "등록된 출처가 없습니다."));
  else for (const source of body.sources) blocks.push(...sourceBlocks(source));

  if (body.excluded.length > 0) {
    blocks.push(...textBlocks("heading_1", "상세로 다루지 못한 이야기"));
    for (const story of body.excluded) blocks.push(...excludedBlocks(story));
  }

  return blocks;
}

export function buildSectionReportProperties(body: SectionReportBody): NotionPageProperties {
  const sectionTitle = SECTION_TITLES_KO[body.section];
  return {
    Name: { title: titleRichText(`${body.date} · ${sectionTitle} 상세`) },
    Date: { date: { start: body.date } },
    Section: { select: { name: sectionTitle } },
    Items: { number: body.entries.length },
    Importance: { number: body.entries.reduce((highest, entry) => Math.max(highest, entry.importance), 0) },
  };
}

/** "AI Radar Reports" DB 로 가는 섹션 상세 리포트 Renderer. */
export class NotionSectionReportRenderer implements Renderer<SectionReportBody> {
  readonly channel = "notion" as const;

  render(artifact: Artifact<SectionReportBody>): Rendered {
    const payload: NotionReportRenderedPayload = {
      kind: "section-report",
      properties: buildSectionReportProperties(artifact.body),
      blocks: buildSectionReportBlocks(artifact.body, artifact.revision),
    };
    return {
      channel: this.channel,
      hash: sha256Hex(canonicalJson(payload)),
      payload,
      preview: `Notion section report(${artifact.body.section}): ${payload.blocks.length} blocks, revision ${artifact.revision}`,
    };
  }
}
