import { readFile } from "node:fs/promises";
import { parseBriefing, type DailyBriefing } from "../schemas/briefing.js";

export async function loadBriefing(filePath: string): Promise<DailyBriefing> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Daily Brief file could not be read (${filePath}): ${message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Daily Brief contains malformed JSON (${filePath}): ${message}`);
  }

  return parseBriefing(json);
}
