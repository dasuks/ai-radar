/**
 * Notion 블록 조립 공용 헬퍼.
 * Daily / Section Report / Digest 렌더러가 모두 여기의 2000자 분할·100개 rich text 제한 규칙을 쓴다.
 * (adapters 내부 같은 그룹 안의 공유이므로 ARCH-06 위반이 아니다.)
 */
import type { BlockObjectRequest, CreatePageParameters } from "@notionhq/client";

/** Notion rich text 한 조각의 최대 길이 */
export const RICH_TEXT_LIMIT = 2_000;
/** 한 블록에 들어갈 수 있는 rich text 조각 수 */
export const RICH_TEXT_ITEMS_LIMIT = 100;
/** 한 번의 append 요청에 넣을 수 있는 블록 수 */
export const BLOCKS_PER_REQUEST = 100;
export const EMPTY_TEXT = "내용 없음";

export type NotionPageProperties = NonNullable<CreatePageParameters["properties"]>;

/** Daily(NotionBlocksRenderer) payload 형태. */
export interface NotionRenderedPayload {
  properties: NotionPageProperties;
  blocks: BlockObjectRequest[];
}

/** Reports DB 로 가는 payload 형태 (section report / digest). */
export interface NotionReportRenderedPayload {
  kind: "section-report" | "digest";
  properties: NotionPageProperties;
  blocks: BlockObjectRequest[];
}

export type TextBlockType =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item"
  | "quote";

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

export type RichTextItem = { type: "text"; text: { content: string; link?: { url: string } } };

export function richText(content: string, url?: string | undefined): RichTextItem[] {
  return [{ type: "text" as const, text: url ? { content, link: { url } } : { content } }];
}

/** 여러 조각을 이어 붙인 rich text (2000자 분할 + 100개 제한 검사). */
export function richTextRun(items: Array<{ content: string; url?: string | undefined }>): RichTextItem[] {
  const out: RichTextItem[] = [];
  for (const item of items) {
    for (const chunk of splitText(item.content)) out.push(...richText(chunk, item.url));
  }
  return out.slice(0, RICH_TEXT_ITEMS_LIMIT);
}

export function textBlock(type: TextBlockType, content: string, url?: string | undefined): BlockObjectRequest {
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
    case "quote":
      return { object: "block", type, quote: blockContent };
    case "paragraph":
      return { object: "block", type, paragraph: blockContent };
  }
}

/** 2000자를 넘으면 첫 블록만 지정 타입이고 나머지는 paragraph 로 이어진다. */
export function textBlocks(type: TextBlockType, content: string, url?: string | undefined): BlockObjectRequest[] {
  return splitText(content).map((chunk, index) => textBlock(index === 0 ? type : "paragraph", chunk, url));
}

/** 여러 링크가 한 문단에 들어가는 경우 (예: "HN 토론 →" · "상세 리포트 →"). */
export function linkParagraph(links: Array<{ label: string; url: string }>, separator = " · "): BlockObjectRequest | null {
  if (links.length === 0) return null;
  const items: Array<{ content: string; url?: string | undefined }> = [];
  links.forEach((link, index) => {
    if (index > 0) items.push({ content: separator });
    items.push({ content: link.label, url: link.url });
  });
  return { object: "block", type: "paragraph", paragraph: { rich_text: richTextRun(items) } };
}

export function titleRichText(title: string): RichTextItem[] {
  const chunks = splitText(title);
  if (chunks.length > RICH_TEXT_ITEMS_LIMIT) {
    throw new Error(`Notion page title exceeds Notion's ${RICH_TEXT_ITEMS_LIMIT * RICH_TEXT_LIMIT}-character limit`);
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

export function divider(): BlockObjectRequest {
  return { object: "block", type: "divider", divider: {} };
}

/** 썸네일 카드가 되는 Notion bookmark 블록. */
export function bookmarkBlock(url: string): BlockObjectRequest {
  return { object: "block", type: "bookmark", bookmark: { url } };
}

/** 부분 실패 상태를 사람이 식별할 수 있게 하는 revision callout (INTEGRATIONS §1.3 item 3). */
export function revisionCallout(revision: number): BlockObjectRequest {
  return {
    object: "block",
    type: "callout",
    callout: { rich_text: richText(`ai-radar:revision:${revision}`) },
  };
}

/** 링크가 rich text link 로 들어갈 수 있는 길이인지 (초과하면 본문으로 따로 적는다). */
export function safeLinkUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return url.length <= RICH_TEXT_LIMIT ? url : undefined;
}

/** 제목 + 링크 한 줄. 링크가 너무 길면 URL 을 별도 문단으로 남긴다. */
export function linkedListItem(title: string, url: string): BlockObjectRequest[] {
  const safeUrl = safeLinkUrl(url);
  const blocks = textBlocks("bulleted_list_item", title, safeUrl);
  if (!safeUrl) blocks.push(...textBlocks("paragraph", url));
  return blocks;
}
