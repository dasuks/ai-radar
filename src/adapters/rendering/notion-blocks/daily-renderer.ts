import { createHash } from "node:crypto";
import type { BlockObjectRequest, CreatePageParameters } from "@notionhq/client";
import type { Artifact } from "../../../domain/artifacts/artifact.js";
import {
  SECTION_TITLES_KO,
  type BriefItem,
  type DailyBriefBody,
  type SourceRef,
} from "../../../domain/artifacts/daily-brief.js";
import type { Rendered, Renderer } from "../../../ports/publishing/index.js";

const RICH_TEXT_LIMIT = 2_000;
const RICH_TEXT_ITEMS_LIMIT = 100;
const MULTI_SELECT_NAME_LIMIT = 100;
const MULTI_SELECT_OPTIONS_LIMIT = 100;
const EMPTY_TEXT = "내용 없음";

export type NotionPageProperties = NonNullable<CreatePageParameters["properties"]>;

/**
 * NotionPublisher 가 해석하는 payload.
 * adapter 간 import 가 금지되므로(ARCH-06) `adapters/notion` 은 같은 형태를 직접 선언한다.
 */
export interface NotionRenderedPayload {
  properties: NotionPageProperties;
  blocks: BlockObjectRequest[];
}

type TextBlockType = "paragraph" | "heading_1" | "heading_2" | "heading_3" | "bulleted_list_item";

/** Notion rich text 2000자 제한. surrogate pair 를 쪼개지 않는다. */
export function splitText(value: string, limit = RICH_TEXT_LIMIT): string[] {
  const text = value || EMPTY_TEXT;
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    const lastCodeUnit = text.charCodeAt(end - 1);
    if (end < text.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function richText(content: string, url?: string) {
  return [{ type: "text" as const, text: url ? { content, link: { url } } : { content } }];
}

function textBlock(type: TextBlockType, content: string, url?: string): BlockObjectRequest {
  const blockContent = { rich_text: richText(content, url) };
  switch (type) {
    case "heading_1":
      return { object: "block", type, heading_1: blockContent };
    case "heading_2":
      return { object: "block", type, heading_2: blockContent };
    case "heading_3":
      return { object: "block", type, heading_3: blockContent };
    case "bulleted_list_item":
      return { object: "block", type, bulleted_list_item: blockContent };
    case "paragraph":
      return { object: "block", type, paragraph: blockContent };
  }
}

function textBlocks(type: TextBlockType, content: string, url?: string): BlockObjectRequest[] {
  return splitText(content).map((chunk, index) => textBlock(index === 0 ? type : "paragraph", chunk, url));
}

function titleRichText(title: string) {
  const chunks = splitText(title);
  if (chunks.length > RICH_TEXT_ITEMS_LIMIT) {
    throw new Error(`Daily Brief title exceeds Notion's ${RICH_TEXT_ITEMS_LIMIT * RICH_TEXT_LIMIT}-character limit`);
  }
  return chunks.flatMap((chunk) => richText(chunk));
}

export function truncateWithoutBreakingSurrogate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function topicNames(items: BriefItem[]): string[] {
  const unique = new Set<string>();
  for (const item of items) {
    unique.add(truncateWithoutBreakingSurrogate(item.title, MULTI_SELECT_NAME_LIMIT));
    if (unique.size === MULTI_SELECT_OPTIONS_LIMIT) break;
  }
  return [...unique];
}

/** 부분 실패 상태를 사람이 식별할 수 있게 하는 revision callout (INTEGRATIONS §1.3 item 3). */
export function revisionCallout(revision: number): BlockObjectRequest {
  return {
    object: "block",
    type: "callout",
    callout: { rich_text: richText(`ai-radar:revision:${revision}`) },
  };
}

function sourceBlocks(source: SourceRef): BlockObjectRequest[] {
  const safeUrl = source.url.length <= RICH_TEXT_LIMIT ? source.url : undefined;
  const blocks = textBlocks("bulleted_list_item", source.title, safeUrl);
  if (!safeUrl) blocks.push(...textBlocks("paragraph", source.url));
  return blocks;
}

function itemBlocks(item: BriefItem): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [
    { object: "block", type: "divider", divider: {} },
    ...textBlocks("heading_2", item.title),
    ...textBlocks("paragraph", `중요도: ${item.importance}/5`),
    ...textBlocks("heading_3", "무엇이 바뀌었나"),
    ...textBlocks("paragraph", item.whatChanged),
    ...textBlocks("heading_3", "왜 중요한가"),
    ...textBlocks("paragraph", item.whyItMatters),
  ];
  if (item.howDevelopersUseIt) {
    blocks.push(...textBlocks("heading_3", "실제 개발자들은 어떻게 쓰나"), ...textBlocks("paragraph", item.howDevelopersUseIt));
  }
  if (item.howToApply) {
    blocks.push(...textBlocks("heading_3", "바로 적용하려면"), ...textBlocks("paragraph", item.howToApply));
  }
  blocks.push(...textBlocks("heading_3", "관련 개념"));
  if (item.related.length === 0) blocks.push(...textBlocks("paragraph", "등록된 관련 개념이 없습니다."));
  else for (const related of item.related) blocks.push(...textBlocks("bulleted_list_item", related));

  blocks.push(...textBlocks("heading_3", "Sources"));
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
