import type { ChannelId } from "../../domain/artifacts/artifact.js";
import {
  findRegion,
  insertRegionAfterHeading,
  looksLikeLegacyDailyNote,
  replaceRegion,
  wrapRegion,
} from "../../domain/shared/markers.js";
import type { PublishOutcome, Publisher, Rendered, VaultPort } from "../../ports/publishing/index.js";
import type { Logger } from "../../ports/system/index.js";

const ILLEGAL_FILENAME_CHARS = new Set(["<", ">", ":", '"', "/", "?", "*", "|"]);

interface MarkdownDailyPayload {
  markdown: string;
  date: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadOf(rendered: Rendered): MarkdownDailyPayload {
  const payload = rendered.payload;
  if (
    !isRecord(payload) ||
    typeof payload.markdown !== "string" ||
    typeof payload.date !== "string" ||
    typeof payload.title !== "string"
  ) {
    throw new Error("Obsidian publisher received a payload that is not { markdown, date, title }");
  }
  return { markdown: payload.markdown, date: payload.date, title: payload.title };
}

/** Windows 파일명으로 안전한 제목 조각. */
export function safeFilenamePart(value: string, fallback: string): string {
  const cleaned = value
    .split("")
    .map((ch) => (ILLEGAL_FILENAME_CHARS.has(ch) || ch.charCodeAt(0) < 0x20 || ch === String.fromCharCode(92) ? "-" : ch))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || fallback;
}

/** 렌더된 Markdown 의 H1 은 노트 자체의 H1 과 중복되므로 관리 영역 본문에서 제외한다. */
export function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^#\s+.*(\r?\n)+/, "").trimEnd();
}

function headingOf(contents: string): string | null {
  return contents.match(/^#\s+(.+?)\s*$/m)?.[1] ?? null;
}

/**
 * PIPELINES_AND_POLICIES.md §8 "마커가 없는 기존 노트에 관리 영역을 처음 넣는 규칙".
 * 1) `daily` 관리 영역(신규 또는 레거시 마커)이 있으면 교체한다.
 * 2) 레거시 생성본이면 H1 다음부터 `## Knowledge Updates` 직전(없으면 파일 끝)까지를 관리 영역으로 교체한다.
 * 3) 그 외에는 사용자 작성 노트로 보고 H1 바로 뒤에 삽입하며 기존 본문을 보존한다.
 */
export function applyDailyRegion(contents: string, body: string): string {
  const replaced = replaceRegion(contents, "daily", body);
  if (replaced !== undefined) return replaced;
  if (!looksLikeLegacyDailyNote(contents)) return insertRegionAfterHeading(contents, "daily", body);

  const heading = contents.match(/^#\s+.+$/m);
  if (!heading || heading.index === undefined) return insertRegionAfterHeading(contents, "daily", body);
  const start = heading.index + heading[0].length;
  const knowledgeUpdates = contents.indexOf("## Knowledge Updates", start);
  const end = knowledgeUpdates >= 0 ? knowledgeUpdates : contents.length;
  const tail = contents.slice(end);
  return `${contents.slice(0, start)}\n\n${wrapRegion("daily", body)}\n\n${tail.trimStart()}`.trimEnd() + "\n";
}

export interface ObsidianDailyPublisherOptions {
  vault: VaultPort;
  dailyFolder: string;
  logger?: Logger;
}

/**
 * Obsidian Daily Note Publisher.
 * 파일은 날짜 접두(`<date> *.md`)로 찾고, 없을 때만 만든다 (R-O3).
 * 관리 영역 밖 사용자 텍스트는 절대 건드리지 않는다 (R-O1).
 */
export class ObsidianDailyPublisher implements Publisher {
  readonly channel: ChannelId = "obsidian";

  constructor(private readonly options: ObsidianDailyPublisherOptions) {}

  async publish(input: {
    artifactId: string;
    revision: number;
    rendered: Rendered;
    existingExternalId: string | null;
    dryRun: boolean;
  }): Promise<PublishOutcome> {
    const payload = payloadOf(input.rendered);
    const body = stripLeadingH1(payload.markdown);
    const expectedHeading = `${payload.date} ${payload.title}`;

    const existingPath = await this.findExistingNote(payload.date, expectedHeading, input.existingExternalId);
    const path = existingPath ?? `${this.options.dailyFolder}/${payload.date} ${safeFilenamePart(payload.title, "AI Intelligence Daily")}.md`;

    const current = existingPath ? await this.options.vault.read(existingPath) : null;
    const next =
      current === null
        ? `# ${expectedHeading}\n\n${wrapRegion("daily", body)}\n`
        : `${applyDailyRegion(current, body).trimEnd()}\n`;

    await this.options.vault.write(path, next, input.dryRun);
    return {
      externalId: path,
      externalUrl: null,
      action: input.dryRun ? "skipped" : current === null ? "created" : "updated",
    };
  }

  private async findExistingNote(
    date: string,
    expectedHeading: string,
    existingExternalId: string | null,
  ): Promise<string | null> {
    if (existingExternalId && (await this.options.vault.exists(existingExternalId))) return existingExternalId;

    const prefix = `${this.options.dailyFolder}/${date}`;
    const notes = await this.options.vault.listNotes(this.options.dailyFolder);
    const candidates = notes.filter((note) => note === `${prefix}.md` || note.startsWith(`${prefix} `));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0] ?? null;

    for (const candidate of candidates) {
      const contents = await this.options.vault.read(candidate);
      if (contents && headingOf(contents) === expectedHeading) {
        this.options.logger?.warn(`multiple daily notes for ${date}; using the one whose H1 matches`, { candidates });
        return candidate;
      }
    }
    const newest = [...candidates].sort().reverse()[0] ?? null;
    this.options.logger?.warn(`multiple daily notes for ${date} and no matching H1; using the newest by name`, {
      candidates,
      chosen: newest,
    });
    return newest;
  }
}
