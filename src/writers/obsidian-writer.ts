import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { DailyBriefing } from "../schemas/briefing.js";

export interface WriteResult {
  outputPath: string;
}

export interface ObsidianWriteOptions {
  vaultRoot: string;
  dailyDirectory: string;
}

function assertInsideVault(vaultRoot: string, target: string): void {
  const pathFromVault = relative(resolve(vaultRoot), resolve(target));
  if (
    pathFromVault === "" ||
    pathFromVault === ".." ||
    pathFromVault.startsWith(`..\\`) ||
    pathFromVault.startsWith("../") ||
    resolve(pathFromVault) === pathFromVault
  ) {
    throw new Error(`Refusing to write outside the Obsidian Vault: ${target}`);
  }
}

function safeFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim() || "AI Coding Daily Brief";
}

export async function writeObsidianDailyNote(
  briefing: Pick<DailyBriefing, "date" | "title">,
  markdown: string,
  options: ObsidianWriteOptions,
): Promise<WriteResult> {
  const filename = `${briefing.date} ${safeFilenamePart(briefing.title)}.md`;
  const outputPath = resolve(options.dailyDirectory, filename);
  assertInsideVault(options.vaultRoot, options.dailyDirectory);
  assertInsideVault(options.vaultRoot, outputPath);
  await mkdir(options.dailyDirectory, { recursive: true });
  await writeFile(outputPath, markdown, "utf8");
  return { outputPath };
}
