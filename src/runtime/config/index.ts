/**
 * 환경변수 + 설정 파일 → typed AppConfig.
 *
 * 이 디렉터리는 `process.env` 를 읽는 **유일한** 장소다 (ARCHITECTURE.md §3.1, ARCH-07).
 * 다른 모든 모듈은 값을 인자로 받는다. dotenv 로딩도 여기서만 한다.
 */
export {
  loadConfig,
  ConfigError,
  DEFAULT_OBSIDIAN_VAULT,
  DEFAULT_TIMEZONE,
  DAILY_FOLDER,
  findProjectRoot,
  type AppConfig,
  type LoadConfigOptions,
  type NotionConfig,
  type NotionReportsConfig,
  type ObsidianConfig,
  type SourcesConfig,
  type RssFeedConfig,
  type LlmConfig,
} from "./app-config.js";
