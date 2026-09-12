import type { BlockObjectRequest } from "@notionhq/client";
import type { Artifact } from "../../../domain/artifacts/artifact.js";
import { BRIEF_SECTION_KINDS, SECTION_TITLES_KO, type BriefSectionKind } from "../../../domain/artifacts/daily-brief.js";
import type { DailyDigestBody, DigestStory } from "../../../domain/artifacts/section-report.js";
import { canonicalJson, sha256Hex } from "../../../domain/shared/ids.js";
import type { Rendered, Renderer } from "../../../ports/publishing/index.js";
import {
  bookmarkBlock,
  linkParagraph,
  revisionCallout,
  safeLinkUrl,
  textBlocks,
  titleRichText,
  type NotionPageProperties,
  type NotionReportRenderedPayload,
} from "./blocks.js";
import { EVIDENCE_LEVEL_LABELS_KO } from "./section-report-renderer.js";

export const DIGEST_SECTION_TITLE = "전체 목록";
const UNCLASSIFIED = "분류 없음";

export interface NotionDigestRendererOptions {
  /** 상세 리포트 페이지 URL 조회. body 에는 URL 이 없으므로 발행 순서를 아는 쪽이 주입한다. */
  reportUrlFor?: ((story: DigestStory) => string | null) | undefined;
}

function storyTags(story: DigestStory): string {
  const tags: string[] = [`[${EVIDENCE_LEVEL_LABELS_KO[story.evidenceLevel]}]`];
  if (story.sourceId) tags.push(`[${story.sourceId}]`);
  if (story.metrics.points !== null) tags.push(`HN ${story.metrics.points}점`);
  if (story.metrics.comments !== null) tags.push(`댓글 ${story.metrics.comments}`);
  return tags.join(" · ");
}

function storyBlocks(story: DigestStory, reportUrl: string | null): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [
    ...textBlocks("heading_3", story.titleKo),
    ...textBlocks("paragraph", story.summary),
    ...textBlocks("paragraph", storyTags(story)),
  ];

  const bookmarkUrl = safeLinkUrl(story.url);
  if (bookmarkUrl) blocks.push(bookmarkBlock(bookmarkUrl));

  const links: Array<{ label: string; url: string }> = [];
  const discussionUrl = safeLinkUrl(story.discussionUrl);
  if (discussionUrl) links.push({ label: "HN 토론 →", url: discussionUrl });
  const detailUrl = safeLinkUrl(reportUrl);
  if (detailUrl) links.push({ label: "상세 리포트 →", url: detailUrl });
  const paragraph = linkParagraph(links);
  if (paragraph) blocks.push(paragraph);

  return blocks;
}

/** 섹션 순서는 domain 의 BRIEF_SECTION_KINDS 순서를 따르고, 분류가 없는 이야기는 마지막에 모은다. */
function groupStories(stories: readonly DigestStory[]): Array<{ title: string; stories: DigestStory[] }> {
  const groups = new Map<BriefSectionKind | "__none__", DigestStory[]>();
  for (const story of stories) {
    const key = story.section ?? "__none__";
    const bucket = groups.get(key);
    if (bucket) bucket.push(story);
    else groups.set(key, [story]);
  }
  const out: Array<{ title: string; stories: DigestStory[] }> = [];
  for (const kind of BRIEF_SECTION_KINDS) {
    const bucket = groups.get(kind);
    if (bucket && bucket.length > 0) out.push({ title: SECTION_TITLES_KO[kind], stories: bucket });
  }
  const unclassified = groups.get("__none__");
  if (unclassified && unclassified.length > 0) out.push({ title: UNCLASSIFIED, stories: unclassified });
  return out;
}

export function buildDigestBlocks(
  body: DailyDigestBody,
  revision: number,
  reportUrlFor?: ((story: DigestStory) => string | null) | undefined,
): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [revisionCallout(revision)];

  const failed = body.coverage.sourcesFailed;
  if (failed.length > 0) blocks.push(...textBlocks("paragraph", `수집 실패: ${failed.join(", ")}`));
  else if (body.coverage.partial) blocks.push(...textBlocks("paragraph", "수집 범위가 일부만 확인되었습니다."));
  if (body.coverage.note) blocks.push(...textBlocks("paragraph", body.coverage.note));

  const reportCount = body.stories.filter((story) => story.reportEntryId !== null).length;
  blocks.push(...textBlocks("paragraph", `오늘 들어온 이야기 ${body.stories.length}개 · 상세 리포트 ${reportCount}개`));

  const groups = groupStories(body.stories);
  if (groups.length === 0) blocks.push(...textBlocks("paragraph", "오늘 들어온 이야기가 없습니다."));
  for (const group of groups) {
    blocks.push(...textBlocks("heading_2", group.title));
    for (const story of group.stories) blocks.push(...storyBlocks(story, reportUrlFor?.(story) ?? null));
  }

  return blocks;
}

export function buildDigestProperties(body: DailyDigestBody): NotionPageProperties {
  return {
    Name: { title: titleRichText(`${body.date} · ${DIGEST_SECTION_TITLE}`) },
    Date: { date: { start: body.date } },
    Section: { select: { name: DIGEST_SECTION_TITLE } },
    Items: { number: body.stories.length },
    Importance: { number: body.stories.reduce((highest, story) => Math.max(highest, story.importance), 0) },
  };
}

/** "AI Radar Reports" DB 로 가는 전체 목록(digest) Renderer. */
export class NotionDigestRenderer implements Renderer<DailyDigestBody> {
  readonly channel = "notion" as const;

  constructor(private readonly options: NotionDigestRendererOptions = {}) {}

  render(artifact: Artifact<DailyDigestBody>): Rendered {
    const payload: NotionReportRenderedPayload = {
      kind: "digest",
      properties: buildDigestProperties(artifact.body),
      blocks: buildDigestBlocks(artifact.body, artifact.revision, this.options.reportUrlFor),
    };
    return {
      channel: this.channel,
      hash: sha256Hex(canonicalJson(payload)),
      payload,
      preview: `Notion digest: ${artifact.body.stories.length} stories, ${payload.blocks.length} blocks, revision ${artifact.revision}`,
    };
  }
}
