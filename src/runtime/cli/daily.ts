import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidCalendarDate } from "../../domain/shared/time.js";
import type { RunStatus } from "../../domain/runs/run.js";
import type { RunDailyPipelineResult } from "../../application/runs/run-daily-pipeline.js";
import { redactText } from "../../adapters/system/logger.js";
import { buildDailyPipeline } from "../composition/build-daily-pipeline.js";
import { loadConfig } from "../config/app-config.js";

const USAGE = `ai-radar daily

  --date YYYY-MM-DD   대상 날짜 (기본: 설정 timezone 기준 오늘)
  --input <file>      수동 Daily Brief JSON (v1/v2 모두 허용)
  --dry-run           쓰기 없이 Notion 호출을 건너뛰고 Obsidian 변경은 diff 로만 출력
  --skip-notion       Notion 채널 건너뛰기
  --skip-obsidian     Obsidian 채널 건너뛰기 (Librarian 도 함께 건너뛴다)
  --skip-librarian    Librarian 만 건너뛰기
  --help              이 도움말`;

/** 종료 코드 1 로 끝나는 Run 상태 (PARTIAL_SUCCESS 는 경고만 남기고 0). */
const FAILING_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "OUTPUT_FAILURE",
  "SOURCE_FAILURE",
  "ANALYSIS_FAILURE",
  "ABORTED",
]);

/**
 * 마지막으로 로드된 설정의 redaction 목록. main() 밖(최상위 rejection 핸들러)에서도
 * 비밀값이 그대로 찍히지 않도록 보관한다 (INTEGRATIONS_AND_SAFETY.md §5.1).
 */
let activeRedaction: string[] = [];

export interface DailyCliArgs {
  date: string | null;
  input: string | null;
  dryRun: boolean;
  skipNotion: boolean;
  skipObsidian: boolean;
  skipLibrarian: boolean;
  help: boolean;
}

export function parseDailyArgs(argv: string[]): DailyCliArgs {
  const args: DailyCliArgs = {
    date: null,
    input: null,
    dryRun: false,
    skipNotion: false,
    skipObsidian: false,
    skipLibrarian: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--date": {
        const value = argv[index + 1];
        if (!value || !isValidCalendarDate(value)) throw new Error("--date requires a valid YYYY-MM-DD value");
        args.date = value;
        index += 1;
        break;
      }
      case "--input": {
        const value = argv[index + 1];
        if (!value) throw new Error("--input requires a file path");
        args.input = value;
        index += 1;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--skip-notion":
        args.skipNotion = true;
        break;
      case "--skip-obsidian":
        args.skipObsidian = true;
        break;
      case "--skip-librarian":
        args.skipLibrarian = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown flag: ${String(flag)}`);
    }
  }
  return args;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: DailyCliArgs;
  try {
    args = parseDailyArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let redaction: string[] = [];
  try {
    const config = loadConfig(undefined, { requireNotion: !args.skipNotion });
    redaction = config.redaction;
    activeRedaction = redaction;
    const pipeline = buildDailyPipeline(config);
    const result = await pipeline.run({
      ...(args.date ? { date: args.date } : {}),
      input: args.input,
      dryRun: args.dryRun,
      skipNotion: args.skipNotion,
      skipObsidian: args.skipObsidian,
      skipLibrarian: args.skipLibrarian,
    });

    printSummary(result, redaction, args.dryRun);
    return FAILING_STATUSES.has(result.status) ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactText(message, redaction));
    return 1;
  }
}

function printSummary(result: RunDailyPipelineResult, redaction: string[], dryRun: boolean): void {
  const ctx = result.context;
  const lines: string[] = [];
  lines.push("");
  lines.push(`Run ${result.runId} ${result.status}${dryRun ? " (dry-run)" : ""}`);
  lines.push(`  date: ${ctx.date}  artifact: ${ctx.artifact ? `${ctx.artifact.id} rev ${ctx.artifact.revision}` : "(none)"}`);
  for (const record of ctx.publications) {
    lines.push(`  ${record.channel}: ${record.status}${record.externalId ? ` -> ${record.externalId}` : ""}`);
  }
  if (ctx.librarian) {
    const librarian = ctx.librarian;
    lines.push(
      `  librarian: ${librarian.created.length} created, ${librarian.updated.length} updated, ` +
        `${librarian.deferred.length} deferred, ${librarian.failures.length} failed`,
    );
  }
  for (const error of ctx.errors) lines.push(`  ! [${error.stage}] ${error.message}`);
  if (result.status === "PARTIAL_SUCCESS") lines.push("  warning: the run finished with partial results");

  const text = redactText(lines.join("\n"), redaction);
  if (FAILING_STATUSES.has(result.status)) console.error(text);
  else console.log(text);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const invokedDirectly = isEntryPoint();
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(redactText(message, activeRedaction));
      process.exitCode = 1;
    },
  );
}
