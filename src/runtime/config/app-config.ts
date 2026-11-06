import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { isRecord } from "../../domain/shared/validation.js";
import { loadDiscordConfig, discordSecrets, type DiscordConfig } from "./discord-config.js";

export const DEFAULT_OBSIDIAN_VAULT = "C:\\dev\\knowledge\\ai-knowledge";
export const DEFAULT_TIMEZONE = "Asia/Seoul";
export const DAILY_FOLDER = "99 Daily";
const DEFAULT_MAX_NOTES_PER_RUN = 20;
const DEFAULT_LLM_PROVIDER = "codex-cli";
/** ADR-0009: 리포트 단계가 섹션마다 1회 + digest 배치 + Daily 1회를 더 쓴다. */
const DEFAULT_LLM_MAX_CALLS = 24;
const DEFAULT_MAX_DOCS = 60;

/** Windows 에서 `codex` 는 .cmd/.ps1 shim 이라 shell 없이 spawn 할 수 없다. 실행 파일을 직접 찾는다. */
function resolveCodexBinary(env: NodeJS.ProcessEnv): string {
  const explicit = env.AI_RADAR_CODEX_BIN?.trim();
  if (explicit) return explicit;
  const npmRoot = env.APPDATA ? join(env.APPDATA, "npm", "node_modules") : null;
  if (npmRoot) {
    const candidates = [
      join(npmRoot, "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      join(npmRoot, "@openai", "codex", "bin", "codex.js"),
    ];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  }
  return "codex";
}
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_HN_MAX_ITEMS = 60;
const PLACEHOLDER_PREFIX = "여기에_";

export class ConfigError extends Error {
  constructor(message: string) {
    super(`[Configuration] ${message}`);
    this.name = "ConfigError";
  }
}

/** INTEGRATIONS_AND_SAFETY.md §1.6 — `AI Radar Reports` DB. 없으면 reports 단계는 SKIPPED. */
export interface NotionReportsConfig {
  databaseId: string;
  dataSourceId?: string;
}

export interface NotionConfig {
  token: string;
  databaseId: string;
  /** NOTION_DATA_SOURCE_ID. 지정하면 데이터 소스 자동 탐색을 건너뛴다 (R-D1) */
  dataSourceId?: string;
  /** NOTION_ALLOW_SCHEMA_FALLBACK === "true" 일 때만 스키마 일치 fallback 허용 (R-N1) */
  allowSchemaFallback: boolean;
  /** NOTION_REPORTS_DATABASE_ID 가 없으면 null (리포트 단계 SKIPPED) */
  reports: NotionReportsConfig | null;
}

export interface ObsidianConfig {
  vaultRoot: string;
  dailyFolder: string;
  maxNotesPerRun: number;
}

export interface RssFeedConfig {
  id: string;
  name: string;
  url: string;
  /** URL 을 아직 실제로 확인하지 못했다는 표시 (UNVERIFIED EXTERNAL CONSTRAINT) */
  unverified?: boolean;
}

export interface SourcesConfig {
  githubTrending?: boolean;
  rssFeeds: RssFeedConfig[];
  threads?: { username: string; accessToken?: string }[];
  hackerNews: { enabled: boolean; maxItems: number };
  windowHours: number;
}

export interface LlmConfig {
  provider: string;
  model: string | null;
  maxCallsPerRun: number;
  /** codex 실행 파일 경로 (AI_RADAR_CODEX_BIN, 없으면 npm 전역 설치 경로 탐색, 최후에 "codex") */
  codexBinary: string;
  /** 분석 대상 문서 수 상한 (AI_RADAR_MAX_DOCS, 기본 60) */
  maxDocumentsPerRun: number;
  timeoutMs: number;
}

export interface AppConfig {
  projectRoot: string;
  notion: NotionConfig;
  obsidian: ObsidianConfig;
  store: { dir: string };
  timezone: string;
  llm: LlmConfig;
  sources: SourcesConfig;
  discord?: DiscordConfig | null;
  /** 로그·오류 메시지에서 마스킹할 secret 값 목록 */
  redaction: string[];
}

export interface LoadConfigOptions {
  /** false 면 Notion 자격증명을 요구하지 않는다 (`--skip-notion`) */
  requireNotion?: boolean;
  /** 설정 파일 탐색 기준 디렉터리 (테스트용) */
  projectRoot?: string;
}

/** package.json + src/ 를 가진 가장 가까운 상위 디렉터리. `.test-dist` 에서 실행해도 진짜 루트를 찾는다. */
export function findProjectRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  let current = resolve(from);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** 레거시 `requiredEnvironmentValue` 와 같은 규칙: 비어 있거나 placeholder 면 거부한다. */
function requiredEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = trimmed(env[name]);
  if (!value || value.startsWith(PLACEHOLDER_PREFIX)) {
    throw new ConfigError(`${name} is missing or still a placeholder`);
  }
  return value;
}

function optionalEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = trimmed(env[name]);
  if (!value || value.startsWith(PLACEHOLDER_PREFIX)) return undefined;
  return value;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = trimmed(raw);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/** `<projectRoot>/config/sources.json` 이 있으면 읽는다. 없으면 빈 목록. */
export function loadRssFeeds(projectRoot: string): RssFeedConfig[] {
  return parseRssFeeds(readSourcesFile(projectRoot));
}

function readSourcesFile(projectRoot: string): unknown {
  const filePath = join(projectRoot, "config", "sources.json");
  if (!existsSync(filePath)) return { feeds: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`config/sources.json contains malformed JSON (${filePath}): ${message}`);
  }
  return parsed;
}

function parseRssFeeds(parsed: unknown): RssFeedConfig[] {
  const rawFeeds = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.feeds : undefined;
  if (!Array.isArray(rawFeeds)) {
    throw new ConfigError('config/sources.json must contain a "feeds" array');
  }
  const feeds: RssFeedConfig[] = [];
  rawFeeds.forEach((raw, index) => {
    if (!isRecord(raw)) throw new ConfigError(`config/sources.json feeds[${index}] must be an object`);
    const id = trimmed(typeof raw.id === "string" ? raw.id : undefined);
    const name = trimmed(typeof raw.name === "string" ? raw.name : undefined);
    const url = trimmed(typeof raw.url === "string" ? raw.url : undefined);
    if (!id || !name || !url) {
      throw new ConfigError(`config/sources.json feeds[${index}] needs non-empty id, name and url`);
    }
    feeds.push(raw.unverified === true ? { id, name, url, unverified: true } : { id, name, url });
  });
  return feeds;
}

function parseThreadsProfiles(parsed: unknown, accessToken: string | undefined): NonNullable<SourcesConfig["threads"]> {
  const profiles = isRecord(parsed) ? parsed.threads ?? [] : [];
  if (!Array.isArray(profiles)) throw new ConfigError("config/sources.json threads must be an array");
  const seen = new Set<string>();
  return profiles.map((profile) => {
    if (!isRecord(profile) || typeof profile.username !== "string" || !/^[A-Za-z0-9_.]{1,30}$/.test(profile.username)) {
      throw new ConfigError("Threads profiles require a valid username");
    }
    const username = profile.username.toLowerCase();
    if (seen.has(username)) throw new ConfigError("Duplicate Threads profile");
    seen.add(username);
    return { username, ...(accessToken ? { accessToken } : {}) };
  });
}

function dotenvIntoProcessEnv(): NodeJS.ProcessEnv {
  loadDotenv({ quiet: true });
  return process.env;
}

/**
 * 환경변수와 설정 파일을 읽어 AppConfig 를 만든다.
 * 인자를 주지 않으면 `.env` 를 로드한 뒤 `process.env` 를 읽는다 (테스트는 env 를 직접 넘긴다).
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = dotenvIntoProcessEnv(),
  options: LoadConfigOptions = {},
): AppConfig {
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const requireNotion = options.requireNotion ?? true;

  const token = requireNotion
    ? requiredEnvironmentValue(env, "NOTION_TOKEN")
    : (optionalEnvironmentValue(env, "NOTION_TOKEN") ?? "");
  const databaseId = requireNotion
    ? requiredEnvironmentValue(env, "NOTION_DATABASE_ID")
    : (optionalEnvironmentValue(env, "NOTION_DATABASE_ID") ?? "");
  const dataSourceId = optionalEnvironmentValue(env, "NOTION_DATA_SOURCE_ID");
  const reportsDatabaseId = optionalEnvironmentValue(env, "NOTION_REPORTS_DATABASE_ID");
  const reportsDataSourceId = optionalEnvironmentValue(env, "NOTION_REPORTS_DATA_SOURCE_ID");
  const reports: NotionReportsConfig | null = reportsDatabaseId
    ? {
        databaseId: reportsDatabaseId,
        ...(reportsDataSourceId === undefined ? {} : { dataSourceId: reportsDataSourceId }),
      }
    : null;

  const notion: NotionConfig = {
    token,
    databaseId,
    ...(dataSourceId === undefined ? {} : { dataSourceId }),
    allowSchemaFallback: trimmed(env.NOTION_ALLOW_SCHEMA_FALLBACK) === "true",
    reports,
  };

  const vaultRoot = resolve(trimmed(env.OBSIDIAN_VAULT_PATH) || DEFAULT_OBSIDIAN_VAULT);
  const obsidian: ObsidianConfig = {
    vaultRoot,
    dailyFolder: DAILY_FOLDER,
    maxNotesPerRun: positiveInteger(env.AI_RADAR_MAX_NOTES_PER_RUN, DEFAULT_MAX_NOTES_PER_RUN, "AI_RADAR_MAX_NOTES_PER_RUN"),
  };

  const storeDir = resolve(trimmed(env.AI_RADAR_STORE_DIR) || join(projectRoot, "data", "store"));
  const discord = loadDiscordConfig(storeDir);

  const llm: LlmConfig = {
    provider: trimmed(env.AI_RADAR_LLM_PROVIDER) || DEFAULT_LLM_PROVIDER,
    model: trimmed(env.AI_RADAR_LLM_MODEL) || null,
    maxCallsPerRun: positiveInteger(env.AI_RADAR_LLM_MAX_CALLS, DEFAULT_LLM_MAX_CALLS, "AI_RADAR_LLM_MAX_CALLS"),
    codexBinary: resolveCodexBinary(env),
    maxDocumentsPerRun: positiveInteger(env.AI_RADAR_MAX_DOCS, DEFAULT_MAX_DOCS, "AI_RADAR_MAX_DOCS"),
    timeoutMs: positiveInteger(env.AI_RADAR_LLM_TIMEOUT_MS, 240_000, "AI_RADAR_LLM_TIMEOUT_MS"),
  };

  const sourceFile = readSourcesFile(projectRoot);
  const threadsAccessToken = optionalEnvironmentValue(env, "THREADS_ACCESS_TOKEN");
  const sources: SourcesConfig = {
    githubTrending: isRecord(sourceFile) && sourceFile.githubTrending === true,
    rssFeeds: parseRssFeeds(sourceFile),
    threads: parseThreadsProfiles(sourceFile, threadsAccessToken),
    hackerNews: {
      enabled: trimmed(env.AI_RADAR_HACKERNEWS_ENABLED) !== "false",
      maxItems: positiveInteger(env.AI_RADAR_HACKERNEWS_MAX_ITEMS, DEFAULT_HN_MAX_ITEMS, "AI_RADAR_HACKERNEWS_MAX_ITEMS"),
    },
    windowHours: positiveInteger(env.AI_RADAR_WINDOW_HOURS, DEFAULT_WINDOW_HOURS, "AI_RADAR_WINDOW_HOURS"),
  };

  const redaction = [...discordSecrets(discord), threadsAccessToken ?? "", token, databaseId, dataSourceId ?? "", reportsDatabaseId ?? "", reportsDataSourceId ?? "", vaultRoot].filter(
    (value) => value.length > 0,
  );

  return {
    projectRoot,
    notion,
    obsidian,
    store: { dir: storeDir },
    timezone: trimmed(env.AI_RADAR_TIMEZONE) || DEFAULT_TIMEZONE,
    llm,
    sources,
    discord,
    redaction,
  };
}
