import {
  allItems,
  type BriefItem,
  type DailyBriefBody,
  type KnowledgeType,
} from "../../domain/artifacts/daily-brief.js";
import { findRegion, replaceRegion, wrapRegion, type ManagedRegion } from "../../domain/shared/markers.js";
import type { VaultPort } from "../../ports/publishing/index.js";
import type { Logger } from "../../ports/system/index.js";
import {
  displayTitle,
  escapeLinkLabel,
  joinVaultPath,
  normalizeKnowledgeTitle,
  noteStem,
  noteTitle,
  sanitizeKnowledgeFilename,
  wikiLink,
} from "./titles.js";

export const KNOWLEDGE_FOLDERS = [
  "00 Inbox",
  "01 Concepts",
  "02 Patterns",
  "03 Workflows",
  "04 Tools",
  "05 Architecture",
  "06 Research",
  "07 Projects",
] as const;

export type KnowledgeFolder = (typeof KNOWLEDGE_FOLDERS)[number];

export const TYPE_FOLDERS: Record<KnowledgeType, KnowledgeFolder> = {
  concept: "01 Concepts",
  pattern: "02 Patterns",
  workflow: "03 Workflows",
  tool: "04 Tools",
  architecture: "05 Architecture",
  research: "06 Research",
};

/** 매핑되지 않은 종류(향후 enum 추가분)는 Inbox 로 보낸다. */
export function folderFor(type: KnowledgeType | null): KnowledgeFolder {
  const folder = type ? (TYPE_FOLDERS as Partial<Record<string, KnowledgeFolder>>)[type] : undefined;
  return folder ?? "00 Inbox";
}

/** Knowledge Note 로 승격할 최소 중요도. */
export const MIN_KNOWLEDGE_IMPORTANCE = 4;

const EMPTY_TEXT = "내용 없음";

export interface LibrarianFailure {
  title: string;
  error: string;
}

export interface LibrarianResult {
  created: string[];
  updated: string[];
  /** 한 Run 상한(maxNotesPerRun)에 걸려 미룬 항목 */
  deferred: string[];
  failures: LibrarianFailure[];
  dailyNotePath: string;
}

export interface RunLibrarianInput {
  body: DailyBriefBody;
  vault: VaultPort;
  /** Obsidian publication 의 externalId (vault 상대 경로) */
  dailyNotePath: string;
  maxNotesPerRun: number;
  dryRun: boolean;
  logger?: Logger;
}

interface IndexedNote {
  path: string;
  title: string;
}

interface KnowledgeLink {
  title: string;
  target: string;
}

type NoteIndex = Map<string, Map<string, IndexedNote>>;

function text(value: string | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed || EMPTY_TEXT;
}

/** knowledgeType 이 있고 충분히 중요한 item 만 지식으로 승격한다. */
export function selectKnowledgeItems(body: DailyBriefBody): BriefItem[] {
  return allItems(body).filter(
    (item) => item.knowledgeType !== null && item.importance >= MIN_KNOWLEDGE_IMPORTANCE,
  );
}

function relatedSection(related: string[]): string {
  if (related.length === 0) return "- 등록된 관련 개념이 없습니다.";
  return related.map((item) => `- ${wikiLink(item)}`).join("\n");
}

/** `content` 관리 영역 본문 (마커는 wrapRegion 이 붙인다). */
export function managedContent(item: BriefItem): string {
  return [
    "## Summary",
    text(item.whatChanged),
    "",
    "## Why it matters",
    text(item.whyItMatters),
    "",
    "## How developers use it",
    text(item.howDevelopersUseIt),
    "",
    "## How to apply",
    text(item.howToApply),
    "",
    "## Related",
    relatedSection(item.related),
  ].join("\n");
}

/** `evidence:<date>` 관리 영역 본문. 같은 날짜는 한 블록만 존재한다. */
export function evidenceContent(item: BriefItem, date: string, dailyNoteTarget: string): string {
  const sources = item.sourceRefs.length
    ? item.sourceRefs.map((source) => `- Source: [${escapeLinkLabel(source.title)}](${source.url})`)
    : ["- Source: 등록된 출처가 없습니다."];
  return [
    `### ${date}`,
    `- Daily Brief: [[${dailyNoteTarget}]]`,
    ...sources,
    `- What changed: ${text(item.whatChanged).replaceAll("\n", "\n  ")}`,
  ].join("\n");
}

function upsertContentRegion(contents: string, item: BriefItem): string {
  const body = managedContent(item);
  const replaced = replaceRegion(contents, "content", body);
  if (replaced !== undefined) return replaced;
  const heading = contents.match(/^#\s+.+$/m);
  const block = wrapRegion("content", body);
  if (!heading || heading.index === undefined) {
    return `# ${displayTitle(item.title)}\n\n${block}\n\n${contents.trim()}`;
  }
  const insertAt = heading.index + heading[0].length;
  return `${contents.slice(0, insertAt)}\n\n${block}${contents.slice(insertAt)}`;
}

/** `## Evidence` 섹션 안에 날짜별 블록 하나를 유지한다. */
function upsertEvidenceRegion(contents: string, date: string, body: string): string {
  const region: ManagedRegion = `evidence:${date}`;
  const replaced = replaceRegion(contents, region, body);
  if (replaced !== undefined) return replaced;

  const block = wrapRegion(region, body);
  const evidenceHeading = /^## Evidence\s*$/m.exec(contents);
  if (!evidenceHeading || evidenceHeading.index === undefined) {
    return `${contents.trimEnd()}\n\n## Evidence\n\n${block}`;
  }
  const sectionStart = evidenceHeading.index + evidenceHeading[0].length;
  const nextHeading = /^##\s+/m.exec(contents.slice(sectionStart));
  const sectionEnd = nextHeading ? sectionStart + (nextHeading.index ?? 0) : contents.length;
  return `${contents.slice(0, sectionEnd).trimEnd()}\n\n${block}\n${contents.slice(sectionEnd)}`;
}

function knowledgeNoteContents(
  current: string | null,
  item: BriefItem,
  date: string,
  dailyNoteTarget: string,
): string {
  const evidence = evidenceContent(item, date, dailyNoteTarget);
  if (current === null) {
    return `${[
      `# ${displayTitle(item.title)}`,
      "",
      wrapRegion("content", managedContent(item)),
      "",
      "## Evidence",
      "",
      wrapRegion(`evidence:${date}`, evidence),
    ].join("\n")}\n`;
  }
  let contents = upsertContentRegion(current, item);
  contents = upsertEvidenceRegion(contents, date, evidence);
  return `${contents.trimEnd()}\n`;
}

function dailyKnowledgeBody(links: KnowledgeLink[]): string {
  const seen = new Set<string>();
  const items = links.flatMap((link) => {
    const normalized = normalizeKnowledgeTitle(link.title);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [`- ${wikiLink(link.title, link.target)}`];
  });
  return (items.length ? items : ["- 업데이트된 지식 노트가 없습니다."]).join("\n");
}

/** Daily Note 의 `knowledge-updates` 관리 영역을 갱신한다 (사용자 텍스트는 건드리지 않는다). */
export function upsertDailyKnowledgeRegion(contents: string, body: string): string {
  const replaced = replaceRegion(contents, "knowledge-updates", body);
  if (replaced !== undefined) return `${replaced.trimEnd()}\n`;

  const block = wrapRegion("knowledge-updates", body);
  const heading = /^## Knowledge Updates\s*$/m.exec(contents);
  if (heading?.index !== undefined) {
    const afterHeading = heading.index + heading[0].length;
    const nextHeading = /^##\s+/m.exec(contents.slice(afterHeading));
    const end = nextHeading ? afterHeading + (nextHeading.index ?? 0) : contents.length;
    return `${`${contents.slice(0, afterHeading)}\n\n${block}\n${contents.slice(end)}`.trimEnd()}\n`;
  }
  return `${contents.trimEnd()}\n\n## Knowledge Updates\n\n${block}\n`;
}

async function buildNoteIndex(vault: VaultPort): Promise<NoteIndex> {
  const index: NoteIndex = new Map();
  for (const folder of KNOWLEDGE_FOLDERS) {
    for (const path of await vault.listNotes(folder)) {
      const contents = (await vault.read(path)) ?? "";
      const note: IndexedNote = { path, title: noteTitle(contents, path) };
      for (const candidate of [note.title, noteStem(path)]) {
        addToIndex(index, candidate, note);
      }
    }
  }
  return index;
}

function addToIndex(index: NoteIndex, title: string, note: IndexedNote): void {
  const normalized = normalizeKnowledgeTitle(title);
  if (!normalized) return;
  const matches = index.get(normalized) ?? new Map<string, IndexedNote>();
  matches.set(note.path.toLocaleLowerCase("en-US"), note);
  index.set(normalized, matches);
}

function resolvedLink(title: string, index: NoteIndex): KnowledgeLink {
  const matches = [...(index.get(normalizeKnowledgeTitle(title))?.values() ?? [])];
  const first = matches[0];
  const target = matches.length === 1 && first ? noteStem(first.path) : sanitizeKnowledgeFilename(title);
  return { title: displayTitle(title), target };
}

async function availableNotePath(vault: VaultPort, folder: string, title: string): Promise<string> {
  const stem = sanitizeKnowledgeFilename(title);
  for (let suffix = 1; suffix < 1_000; suffix += 1) {
    const filename = suffix === 1 ? `${stem}.md` : `${stem} (${suffix}).md`;
    const candidate = joinVaultPath(folder, filename);
    if (!(await vault.exists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free filename for '${title}'`);
}

/**
 * RunLibrarian (PIPELINES_AND_POLICIES.md §8, Phase 1 범위).
 *
 * - 대상은 `knowledgeType !== null` 이고 importance >= 4 인 item, 한 Run 상한까지.
 * - 정규화 제목으로 기존 노트를 찾고, 2개 이상이면 쓰지 않고 실패로 보고한다 (AMBIGUOUS_MATCH).
 * - 관리 영역(`content`, `evidence:<date>`)만 교체하고 그 밖의 사용자 텍스트는 보존한다.
 * - 레거시 `ai-coding-radar:*` 마커는 읽고, 쓸 때는 항상 `ai-radar:*` 로 재기록한다.
 */
export async function runLibrarian(input: RunLibrarianInput): Promise<LibrarianResult> {
  const { body, vault, dryRun } = input;
  const date = body.date;
  const result: LibrarianResult = {
    created: [],
    updated: [],
    deferred: [],
    failures: [],
    dailyNotePath: input.dailyNotePath,
  };

  const selected = selectKnowledgeItems(body);
  const limit = Math.max(0, input.maxNotesPerRun);
  const items = selected.slice(0, limit);
  for (const item of selected.slice(limit)) result.deferred.push(displayTitle(item.title));
  if (result.deferred.length > 0) {
    input.logger?.warn(`deferring ${result.deferred.length} knowledge note(s): max ${limit} per run`);
  }

  const index = await buildNoteIndex(vault);
  const dailyTarget = noteStem(input.dailyNotePath);
  const links: KnowledgeLink[] = [];

  for (const item of items) {
    const title = displayTitle(item.title);
    try {
      const matches = [...(index.get(normalizeKnowledgeTitle(title))?.values() ?? [])];
      if (matches.length > 1) {
        throw new Error(`Multiple existing notes match normalized title '${title}'`);
      }
      const existing = matches[0];
      const folder = folderFor(item.knowledgeType);
      const path = existing?.path ?? (await availableNotePath(vault, folder, title));
      const current = existing ? await vault.read(existing.path) : null;
      const contents = knowledgeNoteContents(current, item, date, dailyTarget);
      await vault.write(path, contents, dryRun);
      if (existing) result.updated.push(path);
      else result.created.push(path);
      addToIndex(index, title, { path, title });
      links.push(resolvedLink(title, index));
      for (const related of item.related) links.push(resolvedLink(related, index));
    } catch (error) {
      result.failures.push({ title, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const dailyContents = await vault.read(input.dailyNotePath);
  if (dailyContents === null) {
    // dry-run 에서는 Daily Note 자체가 아직 쓰이지 않았으므로 실패가 아니다.
    if (dryRun) {
      input.logger?.warn(`dry-run: Daily Note ${input.dailyNotePath} does not exist yet; skipping Knowledge Updates`);
      return result;
    }
    result.failures.push({
      title: input.dailyNotePath,
      error: `Daily Note not found in the vault: ${input.dailyNotePath}`,
    });
    return result;
  }
  const updatedDaily = upsertDailyKnowledgeRegion(dailyContents, dailyKnowledgeBody(links));
  await vault.write(input.dailyNotePath, updatedDaily, dryRun);
  return result;
}

/** 레거시 마커가 남아 있는지 확인하는 읽기 헬퍼 (테스트·진단용). */
export function usesLegacyMarkers(contents: string, region: ManagedRegion): boolean {
  return findRegion(contents, region)?.legacy === true;
}
