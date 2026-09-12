import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { BriefingTopic, DailyBriefing } from "../schemas/briefing.js";
import { RuleBasedTopicExtractor } from "./rule-based-extractor.js";
import type { TopicExtractor } from "./topic-extractor.js";

const KNOWLEDGE_FOLDERS = [
  "00 Inbox",
  "01 Concepts",
  "02 Patterns",
  "03 Workflows",
  "04 Tools",
  "05 Architecture",
  "06 Research",
  "07 Projects",
] as const;

const TYPE_FOLDERS: Record<string, (typeof KNOWLEDGE_FOLDERS)[number]> = {
  concept: "01 Concepts",
  pattern: "02 Patterns",
  workflow: "03 Workflows",
  tool: "04 Tools",
  architecture: "05 Architecture",
  research: "06 Research",
};

const CONTENT_START = "<!-- ai-coding-radar:content:start -->";
const CONTENT_END = "<!-- ai-coding-radar:content:end -->";
const DAILY_SECTION_START = "<!-- ai-coding-radar:knowledge-updates:start -->";
const DAILY_SECTION_END = "<!-- ai-coding-radar:knowledge-updates:end -->";

interface IndexedNote {
  path: string;
  title: string;
}

interface KnowledgeLink {
  title: string;
  target: string;
}

export interface LibrarianFailure {
  title: string;
  error: string;
}

export interface LibrarianResult {
  created: string[];
  updated: string[];
  failures: LibrarianFailure[];
}

export interface LibrarianOptions {
  vaultRoot: string;
  dailyNotePath: string;
  extractor?: TopicExtractor;
}

export function normalizeKnowledgeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

function displayTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "Untitled";
}

export function sanitizeKnowledgeFilename(value: string): string {
  let filename = displayTitle(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!filename) filename = "Untitled";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(filename)) {
    filename = `_${filename}`;
  }
  return filename;
}

function assertInsideVault(vaultRoot: string, target: string): void {
  const pathFromVault = relative(resolve(vaultRoot), resolve(target));
  if (
    pathFromVault === "" ||
    pathFromVault === ".." ||
    pathFromVault.startsWith(`..\\`) ||
    pathFromVault.startsWith("../") ||
    isAbsolute(pathFromVault)
  ) {
    throw new Error(`Refusing to write outside the Obsidian Vault: ${target}`);
  }
}

function noteTitle(contents: string, filePath: string): string {
  const heading = contents.match(/^#\s+(.+?)\s*$/m)?.[1];
  return displayTitle(heading ?? basename(filePath, extname(filePath)));
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(path);
    }
  }
  return files;
}

async function buildNoteIndex(vaultRoot: string) {
  const index = new Map<string, Map<string, IndexedNote>>();
  for (const folder of KNOWLEDGE_FOLDERS) {
    const directory = resolve(vaultRoot, folder);
    assertInsideVault(vaultRoot, directory);
    await mkdir(directory, { recursive: true });
    for (const path of await markdownFiles(directory)) {
      const contents = await readFile(path, "utf8");
      const title = noteTitle(contents, path);
      const note = { path, title };
      for (const candidate of [title, basename(path, extname(path))]) {
        const normalized = normalizeKnowledgeTitle(candidate);
        if (!normalized) continue;
        const matches = index.get(normalized) ?? new Map<string, IndexedNote>();
        matches.set(path.toLocaleLowerCase("en-US"), note);
        index.set(normalized, matches);
      }
    }
  }
  return index;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function availableNotePath(directory: string, title: string): Promise<string> {
  const stem = sanitizeKnowledgeFilename(title);
  for (let suffix = 1; ; suffix += 1) {
    const filename = suffix === 1 ? `${stem}.md` : `${stem} (${suffix}).md`;
    const candidate = resolve(directory, filename);
    if (!(await pathExists(candidate))) return candidate;
  }
}

function cleanWikiText(value: string): string {
  return displayTitle(value).replaceAll("[[", "").replaceAll("]]", "").replaceAll("|", "-");
}

function wikiLink(title: string, target = sanitizeKnowledgeFilename(title)): string {
  const display = cleanWikiText(title);
  return display === target ? `[[${target}]]` : `[[${target}|${display}]]`;
}

function relatedSection(related: string[]): string {
  if (related.length === 0) return "- 등록된 관련 개념이 없습니다.";
  return related.map((item) => `- ${wikiLink(item)}`).join("\n");
}

function managedContent(topic: BriefingTopic): string {
  return [
    CONTENT_START,
    "## Summary",
    topic.whatChanged,
    "",
    "## Why it matters",
    topic.whyItMatters,
    "",
    "## How developers use it",
    topic.howDevelopersUseIt,
    "",
    "## How to apply",
    topic.howToApply,
    "",
    "## Related",
    relatedSection(topic.related),
    CONTENT_END,
  ].join("\n");
}

function sourceLine(title: string, url: string): string {
  const safeTitle = title.replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `- Source: [${safeTitle}](${url})`;
}

function bulletContinuation(value: string): string {
  return value.replaceAll("\n", "\n  ");
}

function evidenceContent(
  briefing: DailyBriefing,
  topic: BriefingTopic,
  dailyNoteTarget: string,
): string {
  const start = `<!-- ai-coding-radar:evidence:${briefing.date}:start -->`;
  const end = `<!-- ai-coding-radar:evidence:${briefing.date}:end -->`;
  const sources = topic.sources.length
    ? topic.sources.map((source) => sourceLine(source.title, source.url))
    : ["- Source: 등록된 출처가 없습니다."];
  return [
    start,
    `### ${briefing.date}`,
    `- Daily Brief: [[${dailyNoteTarget}]]`,
    ...sources,
    `- What changed: ${bulletContinuation(topic.whatChanged)}`,
    end,
  ].join("\n");
}

function replaceMarkedContent(contents: string, replacement: string): string | undefined {
  const start = contents.indexOf(CONTENT_START);
  const end = contents.indexOf(CONTENT_END, start + CONTENT_START.length);
  if (start < 0 || end < 0) return undefined;
  return `${contents.slice(0, start)}${replacement}${contents.slice(end + CONTENT_END.length)}`;
}

function upsertManagedContent(
  contents: string,
  topic: BriefingTopic,
): string {
  const replacement = managedContent(topic);
  const replaced = replaceMarkedContent(contents, replacement);
  if (replaced !== undefined) return replaced;

  const heading = contents.match(/^#\s+.+$/m);
  if (!heading || heading.index === undefined) {
    return `# ${displayTitle(topic.title)}\n\n${replacement}\n\n${contents.trim()}`;
  }
  const insertAt = heading.index + heading[0].length;
  return `${contents.slice(0, insertAt)}\n\n${replacement}${contents.slice(insertAt)}`;
}

function upsertEvidence(
  contents: string,
  evidence: string,
  date: string,
): string {
  const startMarker = `<!-- ai-coding-radar:evidence:${date}:start -->`;
  const endMarker = `<!-- ai-coding-radar:evidence:${date}:end -->`;
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  if (start >= 0 && end >= 0) {
    return `${contents.slice(0, start)}${evidence}${contents.slice(end + endMarker.length)}`;
  }

  const evidenceHeading = /^## Evidence\s*$/m.exec(contents);
  if (!evidenceHeading || evidenceHeading.index === undefined) {
    return `${contents.trimEnd()}\n\n## Evidence\n\n${evidence}`;
  }

  const sectionStart = evidenceHeading.index + evidenceHeading[0].length;
  const nextHeading = /^##\s+/m.exec(contents.slice(sectionStart));
  const sectionEnd = nextHeading
    ? sectionStart + (nextHeading.index ?? 0)
    : contents.length;
  const section = contents.slice(sectionStart, sectionEnd);
  const existingDate = new RegExp(`^###\\s+${date}\\s*$`, "m");
  if (existingDate.test(section)) return contents;

  return `${contents.slice(0, sectionEnd).trimEnd()}\n\n${evidence}\n${contents.slice(sectionEnd)}`;
}

async function updateKnowledgeNote(
  path: string,
  topic: BriefingTopic,
  briefing: DailyBriefing,
  dailyNoteTarget: string,
  exists: boolean,
): Promise<void> {
  const evidence = evidenceContent(briefing, topic, dailyNoteTarget);
  let contents: string;
  if (exists) {
    contents = await readFile(path, "utf8");
    contents = upsertManagedContent(contents, topic);
    contents = upsertEvidence(contents, evidence, briefing.date);
  } else {
    contents = [
      `# ${displayTitle(topic.title)}`,
      "",
      managedContent(topic),
      "",
      "## Evidence",
      "",
      evidence,
    ].join("\n");
  }
  await writeFile(path, `${contents.trimEnd()}\n`, "utf8");
}

function addToIndex(
  index: Map<string, Map<string, IndexedNote>>,
  title: string,
  path: string,
): void {
  const normalized = normalizeKnowledgeTitle(title);
  const matches = index.get(normalized) ?? new Map<string, IndexedNote>();
  matches.set(path.toLocaleLowerCase("en-US"), { path, title });
  index.set(normalized, matches);
}

function resolvedLink(
  title: string,
  index: Map<string, Map<string, IndexedNote>>,
): KnowledgeLink {
  const matches = [...(index.get(normalizeKnowledgeTitle(title))?.values() ?? [])];
  const target =
    matches.length === 1
      ? basename(matches[0]!.path, extname(matches[0]!.path))
      : sanitizeKnowledgeFilename(title);
  return { title: displayTitle(title), target };
}

function dailyKnowledgeSection(links: KnowledgeLink[]): string {
  const seen = new Set<string>();
  const items = links.flatMap((link) => {
    const normalized = normalizeKnowledgeTitle(link.title);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [`- ${wikiLink(link.title, link.target)}`];
  });
  return [
    "## Knowledge Updates",
    "",
    DAILY_SECTION_START,
    ...(items.length ? items : ["- 업데이트된 지식 노트가 없습니다."]),
    DAILY_SECTION_END,
  ].join("\n");
}

function upsertDailyKnowledgeSection(contents: string, section: string): string {
  const markerStart = contents.indexOf(DAILY_SECTION_START);
  const markerEnd = contents.indexOf(
    DAILY_SECTION_END,
    markerStart + DAILY_SECTION_START.length,
  );
  if (markerStart >= 0 && markerEnd >= 0) {
    const headingBeforeMarker = contents.lastIndexOf("## Knowledge Updates", markerStart);
    const replaceStart = headingBeforeMarker >= 0 ? headingBeforeMarker : markerStart;
    return `${contents.slice(0, replaceStart).trimEnd()}\n\n${section}${contents.slice(markerEnd + DAILY_SECTION_END.length)}`;
  }

  const heading = /^## Knowledge Updates\s*$/m.exec(contents);
  if (heading?.index !== undefined) {
    const afterHeading = heading.index + heading[0].length;
    const nextHeading = /^##\s+/m.exec(contents.slice(afterHeading));
    const end = nextHeading ? afterHeading + (nextHeading.index ?? 0) : contents.length;
    return `${contents.slice(0, heading.index).trimEnd()}\n\n${section}\n${contents.slice(end)}`;
  }
  return `${contents.trimEnd()}\n\n${section}`;
}

export async function runObsidianLibrarian(
  briefing: DailyBriefing,
  options: LibrarianOptions,
): Promise<LibrarianResult> {
  assertInsideVault(options.vaultRoot, options.dailyNotePath);
  const extractor = options.extractor ?? new RuleBasedTopicExtractor();
  const topics = await extractor.extract(briefing);
  const index = await buildNoteIndex(options.vaultRoot);
  const dailyTarget = basename(options.dailyNotePath, extname(options.dailyNotePath));
  const result: LibrarianResult = { created: [], updated: [], failures: [] };
  const links: KnowledgeLink[] = [];

  for (const topic of topics) {
    try {
      const title = displayTitle(topic.title);
      const normalized = normalizeKnowledgeTitle(title);
      const matches = [...(index.get(normalized)?.values() ?? [])];
      if (matches.length > 1) {
        throw new Error(`Multiple existing notes match normalized title '${title}'`);
      }

      const existing = matches[0];
      const folder = TYPE_FOLDERS[topic.type.trim().toLowerCase()] ?? "00 Inbox";
      const directory = resolve(options.vaultRoot, folder);
      const path = existing?.path ?? (await availableNotePath(directory, title));
      assertInsideVault(options.vaultRoot, path);
      await updateKnowledgeNote(
        path,
        topic,
        briefing,
        dailyTarget,
        existing !== undefined,
      );
      if (existing) result.updated.push(path);
      else result.created.push(path);
      addToIndex(index, title, path);
      links.push(resolvedLink(title, index));
      for (const related of topic.related) links.push(resolvedLink(related, index));
    } catch (error) {
      result.failures.push({
        title: displayTitle(topic.title),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const dailyContents = await readFile(options.dailyNotePath, "utf8");
  const dailySection = dailyKnowledgeSection(links);
  const updatedDaily = upsertDailyKnowledgeSection(dailyContents, dailySection);
  await writeFile(options.dailyNotePath, `${updatedDaily.trimEnd()}\n`, "utf8");
  return result;
}
