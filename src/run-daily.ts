import { basename } from "node:path";
import { config } from "dotenv";
import { getAppPaths } from "./config/paths.js";
import { formatDailyMarkdown } from "./formatters/daily-markdown.js";
import { runObsidianLibrarian } from "./librarian/obsidian-librarian.js";
import { loadBriefing } from "./loaders/briefing-loader.js";
import { writeNotionDailyBrief } from "./writers/notion-writer.js";
import { writeObsidianDailyNote } from "./writers/obsidian-writer.js";

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("여기에_")) {
    throw new Error(`[Configuration] ${name} is missing or still a placeholder`);
  }
  return value;
}

function errorMessage(error: unknown, valuesToRedact: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of valuesToRedact) {
    if (value) message = message.replaceAll(value, "[REDACTED]");
  }
  return message;
}

async function main(): Promise<void> {
  config({ quiet: true });
  const notionToken = requiredEnvironmentValue("NOTION_TOKEN");
  const notionDatabaseId = requiredEnvironmentValue("NOTION_DATABASE_ID");
  const paths = getAppPaths();
  const valuesToRedact = [notionToken, notionDatabaseId, paths.vaultRoot];

  let briefing;
  try {
    briefing = await loadBriefing(paths.inputFile);
  } catch (error) {
    throw new Error(`[Input] ${errorMessage(error, valuesToRedact)}`);
  }
  const markdown = formatDailyMarkdown(briefing);
  let dailyNotePath: string;

  try {
    const result = await writeObsidianDailyNote(briefing, markdown, paths);
    dailyNotePath = result.outputPath;
    console.log(`[Obsidian] Daily Note saved: ${basename(result.outputPath)}`);
  } catch (error) {
    throw new Error(`[Obsidian] ${errorMessage(error, valuesToRedact)}`);
  }

  try {
    const result = await writeNotionDailyBrief(briefing, {
      token: notionToken,
      databaseId: notionDatabaseId,
    });
    console.log(`[Notion] Page ${result.action}: ${result.pageId}`);
  } catch (error) {
    throw new Error(`[Notion] ${errorMessage(error, valuesToRedact)}`);
  }

  try {
    const result = await runObsidianLibrarian(briefing, {
      vaultRoot: paths.vaultRoot,
      dailyNotePath,
    });
    console.log(
      `[Librarian] Knowledge notes: ${result.created.length} created, ${result.updated.length} updated`,
    );
    if (result.failures.length > 0) {
      const details = result.failures
        .map(
          (failure) =>
            `${failure.title}: ${errorMessage(failure.error, valuesToRedact)}`,
        )
        .join("; ");
      throw new Error(`${result.failures.length} topic(s) failed: ${details}`);
    }
  } catch (error) {
    throw new Error(`[Librarian] ${errorMessage(error, valuesToRedact)}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
