import { createHash } from "node:crypto";
import type { Artifact } from "../../../domain/artifacts/artifact.js";
import {
  SECTION_TITLES_KO,
  type ApplyCandidate,
  type BriefItem,
  type DailyBriefBody,
  type SourceRef,
} from "../../../domain/artifacts/daily-brief.js";
import type { Rendered, Renderer } from "../../../ports/publishing/index.js";

export interface MarkdownDailyPayload {
  markdown: string;
  date: string;
  title: string;
}

const EMPTY_TEXT = "내용 없음";

function escapeLinkLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function sourceLine(source: SourceRef): string {
  return `- [${escapeLinkLabel(source.title)}](${source.url})`;
}

function text(value: string | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed || EMPTY_TEXT;
}

/**
 * Daily 의 항목은 짧게 유지한다. 긴 서술·인용·적용 방법은 섹션 상세 리포트가 담는다
 * (사용자 요구 2026-09-13).
 */
function renderItem(item: BriefItem): string[] {
  const lines: string[] = [`### ${item.title}`, "", `**중요도:** ${item.importance}/5`, ""];
  lines.push("#### 무엇이 바뀌었나", text(item.whatChanged), "");
  lines.push("#### 왜 중요한가", text(item.whyItMatters), "");
  lines.push("#### Sources");
  lines.push(
    item.sourceRefs.length > 0
      ? item.sourceRefs.map(sourceLine).join("\n")
      : "- 등록된 출처가 없습니다.",
  );
  return lines;
}

function renderApplyCandidates(candidates: ApplyCandidate[], titleOf: (itemId: string) => string): string {
  if (candidates.length === 0) return "- 오늘 적용할 후보가 없습니다.";
  return candidates
    .map((candidate) => `- **${titleOf(candidate.itemId)}** (${candidate.effort}): ${candidate.action}`)
    .join("\n");
}

/** PIPELINES_AND_POLICIES.md §8 Daily Note 구조. coverage 는 실패/부분 수집일 때만 표기한다. */
export function renderDailyMarkdown(body: DailyBriefBody): string {
  const items = body.sections.flatMap((section) => section.items);
  const titleOf = (itemId: string): string =>
    items.find((item) => item.id === itemId)?.title ?? itemId;

  const lines: string[] = [`# ${body.date} ${body.title}`, ""];

  const failed = body.coverage.sourcesFailed;
  if (failed.length > 0) {
    lines.push(`> 수집 실패: ${failed.join(", ")}`, "");
  } else if (body.coverage.partial) {
    lines.push("> 수집 범위가 일부만 확인되었습니다.", "");
  }
  if (body.coverage.note && !body.coverage.note.startsWith("수집 실패")) lines.push(`> ${body.coverage.note}`, "");

  lines.push("## 오늘 1분 요약", "");
  lines.push(
    body.oneMinuteSummary.length > 0
      ? body.oneMinuteSummary.map((entry) => `- ${entry}`).join("\n")
      : "- 등록된 요약이 없습니다.",
  );
  lines.push("");

  if (body.sections.length === 0) {
    lines.push("오늘 등록된 주제가 없습니다.", "");
  }
  for (const section of body.sections) {
    lines.push(`## ${SECTION_TITLES_KO[section.kind]}`, "");
    const reportUrl = section.report?.externalUrl;
    if (reportUrl) lines.push(`[상세 리포트 →](${reportUrl})`, "");
    section.items.forEach((item, index) => {
      if (index > 0) lines.push("---", "");
      lines.push(...renderItem(item), "");
    });
  }

  lines.push("## 오늘 하나만 배운다면", "");
  lines.push(
    body.learnOneThing
      ? `**${body.learnOneThing.title}** — ${text(body.learnOneThing.whyItMatters)}`
      : "오늘 고른 항목이 없습니다.",
  );
  lines.push("");

  lines.push("## 내 환경에 적용할 후보", "");
  lines.push(renderApplyCandidates(body.applyCandidates, titleOf));
  lines.push("");

  const digestUrl = body.digest?.externalUrl;
  if (digestUrl) lines.push(`[오늘 들어온 이야기 전체 목록 →](${digestUrl})`, "");

  lines.push("## Sources", "");
  lines.push(
    body.sources.length > 0 ? body.sources.map(sourceLine).join("\n") : "- 등록된 출처가 없습니다.",
  );
  lines.push("");

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Obsidian 채널 Renderer. 내용은 바꾸지 않고 표현만 바꾼다 (ARCHITECTURE §4.1). */
export class MarkdownDailyRenderer implements Renderer<DailyBriefBody> {
  readonly channel = "obsidian" as const;

  render(artifact: Artifact<DailyBriefBody>): Rendered {
    const markdown = renderDailyMarkdown(artifact.body);
    const payload: MarkdownDailyPayload = {
      markdown,
      date: artifact.body.date,
      title: artifact.body.title,
    };
    return {
      channel: this.channel,
      hash: createHash("sha256").update(markdown, "utf8").digest("hex"),
      payload,
      preview: markdown,
    };
  }
}
