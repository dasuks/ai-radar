export interface BriefingSource {
  title: string;
  url: string;
}

export interface BriefingTopic {
  id: string;
  title: string;
  type: string;
  importance: number;
  whatChanged: string;
  whyItMatters: string;
  howDevelopersUseIt: string;
  howToApply: string;
  related: string[];
  sources: BriefingSource[];
}

export interface DailyBriefing {
  date: string;
  title: string;
  summary: string[];
  topics: BriefingTopic[];
}

export class BriefingValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Daily Brief validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "BriefingValidationError";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  object: JsonObject,
  key: string,
  path: string,
  fallback: string,
  issues: string[],
): string {
  const value = object[key];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    issues.push(`${path}.${key} must be a string`);
    return fallback;
  }
  return value.trim() || fallback;
}

function stringArray(
  value: unknown,
  path: string,
  issues: string[],
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of strings`);
    return [];
  }

  return value.flatMap((item, index) => {
    if (typeof item !== "string") {
      issues.push(`${path}[${index}] must be a string`);
      return [];
    }
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

function parseSource(
  value: unknown,
  path: string,
  issues: string[],
): BriefingSource | undefined {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }

  const title = optionalString(value, "title", path, "Source", issues);
  const url = optionalString(value, "url", path, "", issues);
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push(`${path}.url must use http or https`);
    }
  } catch {
    issues.push(`${path}.url must be a valid URL`);
  }

  return { title, url };
}

function parseTopic(
  value: unknown,
  index: number,
  issues: string[],
): BriefingTopic | undefined {
  const path = `topics[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }

  const id = optionalString(value, "id", path, `topic-${index + 1}`, issues);
  const title = optionalString(value, "title", path, id, issues);
  const importanceValue = value.importance;
  let importance = 3;
  if (importanceValue !== undefined && importanceValue !== null) {
    if (
      typeof importanceValue !== "number" ||
      !Number.isInteger(importanceValue) ||
      importanceValue < 1 ||
      importanceValue > 5
    ) {
      issues.push(`${path}.importance must be an integer from 1 to 5`);
    } else {
      importance = importanceValue;
    }
  }

  const sourceValues = value.sources ?? [];
  const sources: BriefingSource[] = [];
  if (!Array.isArray(sourceValues)) {
    issues.push(`${path}.sources must be an array`);
  } else {
    sourceValues.forEach((source, sourceIndex) => {
      const parsed = parseSource(source, `${path}.sources[${sourceIndex}]`, issues);
      if (parsed) sources.push(parsed);
    });
  }

  return {
    id,
    title,
    type: optionalString(value, "type", path, "note", issues),
    importance,
    whatChanged: optionalString(value, "whatChanged", path, "내용 없음", issues),
    whyItMatters: optionalString(value, "whyItMatters", path, "내용 없음", issues),
    howDevelopersUseIt: optionalString(
      value,
      "howDevelopersUseIt",
      path,
      "내용 없음",
      issues,
    ),
    howToApply: optionalString(value, "howToApply", path, "내용 없음", issues),
    related: stringArray(value.related, `${path}.related`, issues),
    sources,
  };
}

export function parseBriefing(value: unknown): DailyBriefing {
  const issues: string[] = [];
  if (!isObject(value)) {
    throw new BriefingValidationError(["root must be a JSON object"]);
  }

  const date = optionalString(value, "date", "root", "", issues);
  if (!date || !isValidDate(date)) {
    issues.push("root.date must be a valid date in YYYY-MM-DD format");
  }

  const topicValues = value.topics ?? [];
  const topics: BriefingTopic[] = [];
  if (!Array.isArray(topicValues)) {
    issues.push("root.topics must be an array");
  } else {
    topicValues.forEach((topic, index) => {
      const parsed = parseTopic(topic, index, issues);
      if (parsed) topics.push(parsed);
    });
  }

  const briefing: DailyBriefing = {
    date,
    title: optionalString(value, "title", "root", "AI Coding Daily Brief", issues),
    summary: stringArray(value.summary, "root.summary", issues),
    topics,
  };

  if (issues.length > 0) throw new BriefingValidationError(issues);
  return briefing;
}
