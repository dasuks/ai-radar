import { createHash } from "node:crypto";
import type { BlockObjectRequest } from "@notionhq/client";
import type { Artifact } from "../../../domain/artifacts/artifact.js";
import {
  SECTION_TITLES_KO,
  type BriefItem,
  type DailyBriefBody,
  type SourceRef,
} from "../../../domain/artifacts/daily-brief.js";
import type { Rendered, Renderer } from "../../../ports/publishing/index.js";
import {
  divider,
  linkedListItem,
  revisionCallout,
  safeLinkUrl,
  textBlocks,
  titleRichText,
  truncateWithoutBreakingSurrogate,
  type NotionPageProperties,
  type NotionRenderedPayload,
} from "./blocks.js";

const MULTI_SELECT_NAME_LIMIT = 100;
const MULTI_SELECT_OPTIONS_LIMIT = 100;

export {
  revisionCallout,
  splitText,
  truncateWithoutBreakingSurrogate,
  type NotionPageProperties,
  type NotionRenderedPayload,
} from "./blocks.js";

function topicNames(items: BriefItem[]): string[] {
  const unique = new Set<string>();
  for (const item of items) {
    unique.add(truncateWithoutBreakingSurrogate(item.title, MULTI_SELECT_NAME_LIMIT));
    if (unique.size === MULTI_SELECT_OPTIONS_LIMIT) break;
  }
  return [...unique];
}

function sourceBlocks(source: SourceRef): BlockObjectRequest[] {
  return linkedListItem(source.title, source.url);
}

/**
 * Daily 의 항목은 짧게 유지한다. 긴 서술·인용·적용 방법은 섹션 상세 리포트가 담는다
 * (사용자 요구 2026-09-13).
 */
function itemBlocks(item: BriefItem): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [
    divider(),
    ...textBlocks("heading_2", item.title),
    ...textBlocks("paragraph", `중요도: ${item.importance}/5`),
    ...textBlocks("heading_3", "무엇이 바뀌었나"),
    ...textBlocks("paragraph", item.whatChanged),
    ...textBlocks("heading_3", "왜 중요한가"),
    ...textBlocks("paragraph", item.whyItMatters),
    ...textBlocks("heading_3", "Sources"),
  ];
  if (item.sourceRefs.length === 0) blocks.push(...textBlocks("paragraph", "등록된 출처가 없습니다."));
  else for (const source of item.sourceRefs) blocks.push(...sourceBlocks(source));
  return blocks;
}

export function buildNotionBlocks(body: DailyBriefBody, revision: number): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [revisionCallout(revision)];

  const failed = body.coverage.sourcesFailed;
  if (failed.length > 0) blocks.push(...textBlocks("paragraph", `수집 실패: ${failed.join(", ")}`));
  else if (body.coverage.partial) blocks.push(...textBlocks("paragraph", "수집 범위가 일부만 확인되었습니다."));
  if (body.coverage.note) blocks.push(...textBlocks("paragraph", body.coverage.note));

  blocks.push(...textBlocks("heading_1", "오늘 1분 요약"));
  if (body.oneMinuteSummary.length === 0) blocks.push(...textBlocks("paragraph", "등록된 요약이 없습니다."));
  else for (const summary of body.oneMinuteSummary) blocks.push(...textBlocks("bulleted_list_item", summary));

  if (body.sections.length === 0) blocks.push(...textBlocks("paragraph", "오늘 등록된 주제가 없습니다."));
  const items: BriefItem[] = [];
  for (const section of body.sections) {
    blocks.push(...textBlocks("heading_1", SECTION_TITLES_KO[section.kind]));
    const reportUrl = safeLinkUrl(section.report?.externalUrl);
    if (reportUrl) blocks.push(...textBlocks("paragraph", "상세 리포트 →", reportUrl));
    for (const item of section.items) {
      items.push(item);
      blocks.push(...itemBlocks(item));
    }
  }

  blocks.push(...textBlocks("heading_1", "오늘 하나만 배운다면"));
  blocks.push(
    ...textBlocks(
      "paragraph",
      body.learnOneThing ? `${body.learnOneThing.title}: ${body.learnOneThing.whyItMatters}` : "오늘 고른 항목이 없습니다.",
    ),
  );

  blocks.push(...textBlocks("heading_1", "내 환경에 적용할 후보"));
  if (body.applyCandidates.length === 0) blocks.push(...textBlocks("paragraph", "오늘 적용할 후보가 없습니다."));
  else
    for (const candidate of body.applyCandidates) {
      const title = items.find((item) => item.id === candidate.itemId)?.title ?? candidate.itemId;
      blocks.push(...textBlocks("bulleted_list_item", `${title} (${candidate.effort}): ${candidate.action}`));
    }

  const digestUrl = safeLinkUrl(body.digest?.externalUrl);
  if (digestUrl) blocks.push(...textBlocks("paragraph", "오늘 들어온 이야기 전체 목록 →", digestUrl));

  blocks.push(...textBlocks("heading_1", "Sources"));
  if (body.sources.length === 0) blocks.push(...textBlocks("paragraph", "등록된 출처가 없습니다."));
  else for (const source of body.sources) blocks.push(...sourceBlocks(source));

  return blocks;
}

export function buildNotionProperties(body: DailyBriefBody): NotionPageProperties {
  const items = body.sections.flatMap((section) => section.items);
  return {
    Name: { title: titleRichText(body.title) },
    Date: { date: { start: body.date } },
    Topics: { multi_select: topicNames(items).map((name) => ({ name })) },
    Importance: { number: items.reduce((highest, item) => Math.max(highest, item.importance), 0) },
  };
}

/** Notion 채널 Renderer. Markdown 렌더러와 같은 내용을 Notion 블록으로 표현한다. */
export class NotionBlocksRenderer implements Renderer<DailyBriefBody> {
  readonly channel = "notion" as const;

  render(artifact: Artifact<DailyBriefBody>): Rendered {
    const payload: NotionRenderedPayload = {
      properties: buildNotionProperties(artifact.body),
      blocks: buildNotionBlocks(artifact.body, artifact.revision),
    };
    return {
      channel: this.channel,
      hash: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
      payload,
      preview: `Notion: ${payload.blocks.length} blocks, revision ${artifact.revision}`,
    };
  }
}
