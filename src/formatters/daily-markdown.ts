import type { BriefingSource, BriefingTopic, DailyBriefing } from "../schemas/briefing.js";

function escapeLinkLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function formatSources(sources: BriefingSource[]): string {
  if (sources.length === 0) return "- 등록된 출처가 없습니다.";
  return sources
    .map((source) => `- [${escapeLinkLabel(source.title)}](${source.url})`)
    .join("\n");
}

function formatRelated(related: string[]): string {
  if (related.length === 0) return "- 등록된 관련 개념이 없습니다.";
  return related.map((item) => `- [[${item.replaceAll("]]", "")}]]`).join("\n");
}

function formatTopic(topic: BriefingTopic): string {
  return [
    `## ${topic.title}`,
    "",
    `**중요도:** ${topic.importance}/5`,
    "",
    "### 무엇이 바뀌었나",
    topic.whatChanged,
    "",
    "### 왜 중요한가",
    topic.whyItMatters,
    "",
    "### 실제 개발자들은 어떻게 쓰나",
    topic.howDevelopersUseIt,
    "",
    "### 바로 적용하려면",
    topic.howToApply,
    "",
    "### 관련 개념",
    formatRelated(topic.related),
    "",
    "### Sources",
    formatSources(topic.sources),
  ].join("\n");
}

export function formatDailyMarkdown(briefing: DailyBriefing): string {
  const summary = briefing.summary.length
    ? briefing.summary.map((item) => `- ${item}`).join("\n")
    : "- 등록된 요약이 없습니다.";
  const topics = briefing.topics.length
    ? briefing.topics.map(formatTopic).join("\n\n---\n\n")
    : "오늘 등록된 주제가 없습니다.";

  return [
    `# ${briefing.date} ${briefing.title}`,
    "",
    "## 오늘 이것만 알면 됨",
    "",
    summary,
    "",
    topics,
    "",
  ].join("\n");
}
