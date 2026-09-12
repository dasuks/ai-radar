/**
 * Codex CLI LlmProvider (`codex exec`).
 *
 * INTEGRATIONS_AND_SAFETY.md §3: 자격증명은 생성자 인자, 로그에는 provider/model 만,
 * prompt 본문(비신뢰 데이터)은 로그에 남기지 않는다. tool calling 은 언제나 비활성.
 *
 * 비신뢰 텍스트(문서 본문)는 **인자로 넘기지 않는다**. argv 에는 코드 상수 플래그와 우리가 만든
 * 파일 경로만 들어가고, prompt 전체는 stdin 으로 흘려보낸 뒤 stdin 을 닫는다.
 * VERIFIED (Codex CLI 0.154.0, Windows): positional prompt 를 생략하면 codex 는
 * `Reading prompt from stdin...` 을 찍고 stdin 을 끝까지 읽는다. 확인 명령:
 * `cat prompt.txt | codex exec -s read-only --ephemeral --skip-git-repo-check -C <dir> --output-schema schema.json -o out.json`
 * → exit 0, out.json 생성, 약 10.8초, stdout/stderr 모두 멈추지 않음.
 *
 * UNVERIFIED EXTERNAL CONSTRAINT: `codex exec` 의 stdout 헤더 형식(model/tokens used)은
 * Codex CLI 0.154.0 기준이며 버전이 올라가면 usage 파싱이 0 으로 떨어질 수 있다(치명적이지 않음).
 * 확인 방법: 위 명령의 stderr 헤더.
 *
 * ARCH-08: `node:child_process` 는 이 adapter 와 horizon adapter 에서만 import 한다.
 * 테스트는 `spawnImpl` 로 stub 을 주입한다. `binary` 가 `.js` 로 끝나면 `process.execPath <binary>` 로 실행한다.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from "../../../domain/evidence/untrusted.js";
import type {
  LlmCapabilities,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from "../../../ports/llm/llm-provider.js";
import type { Logger } from "../../../ports/system/index.js";

/** node:child_process 의 spawn 과 구조적으로 호환되는 최소 타입. */
export interface CodexStream {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  setEncoding?(encoding: string): unknown;
}

/** child.stdin 중 우리가 쓰는 부분. prompt 를 흘려보내고 닫는 용도로만 쓴다. */
export interface CodexWritable {
  write(chunk: string, encoding?: string, callback?: (error?: Error | null) => void): unknown;
  end(callback?: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface CodexProcess {
  readonly stdin: CodexWritable | null;
  readonly stdout: CodexStream | null;
  readonly stderr: CodexStream | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: string): unknown;
}

export interface CodexSpawnOptions {
  cwd: string;
  /** prompt(비신뢰 텍스트)를 stdin 으로 보내야 하므로 stdin 도 pipe 다. 쓰고 나면 즉시 닫는다. */
  stdio: ["pipe", "pipe", "pipe"];
  shell: false;
  windowsHide: boolean;
}

export type SpawnCodex = (command: string, args: string[], options: CodexSpawnOptions) => CodexProcess;

export interface CodexCliProviderOptions {
  /** codex 가 실행될 작업 디렉터리 (`-C`). 임시 schema/out 파일도 이 밑에 만든다. */
  workDir: string;
  /** 테스트용 spawn stub. 생략하면 node:child_process.spawn 을 쓴다. */
  spawnImpl?: SpawnCodex;
  binary?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  /** `-c model_reasoning_effort="<value>"` (cheap tier). codex 가 거부하면 1회 재시도한다. */
  reasoningEffort?: string;
  logger?: Logger;
}

export class CodexCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    /** 진단용. 비신뢰 내용을 포함할 수 있으므로 로그로 내보내지 않는다. */
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "CodexCliError";
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;
const JSON_ONLY_SUFFIX = "Respond with JSON only, matching the provided schema.";

/** LlmRequest → codex 에 넘길 단일 prompt 문자열. */
export function buildPrompt(req: LlmRequest): string {
  return [UNTRUSTED_PREAMBLE, req.system, wrapUntrusted(req.untrusted), JSON_ONLY_SUFFIX].join("\n\n");
}

export interface CodexArgsInput {
  workDir: string;
  schemaPath: string;
  outPath: string;
  model: string;
  extraArgs?: string[];
  reasoningEffort?: string | undefined;
}

/**
 * `codex exec` 인자 조립 (순수 함수, 테스트 대상).
 * argv 에는 코드 상수와 우리가 만든 파일 경로만 들어간다. prompt(비신뢰 텍스트)는 stdin 으로 간다.
 */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const args = [
    "exec",
    "-s",
    "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    input.workDir,
    "--output-schema",
    input.schemaPath,
    "-o",
    input.outPath,
  ];
  if (input.model && input.model !== "default") args.push("-m", input.model);
  if (input.reasoningEffort) args.push("-c", `model_reasoning_effort="${input.reasoningEffort}"`);
  for (const extra of input.extraArgs ?? []) args.push(extra);
  return args;
}

export interface CodexHeader {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * 실행 헤더에서 model 과 token 수를 best effort 로 읽는다.
 *
 * VERIFIED (Codex CLI 0.154.0, Windows): 헤더와 `tokens used` 는 stderr 로 나가고 stdout 에는 최종 JSON 만 나온다.
 * 형식: `model: gpt-5.6-sol` / `tokens used` 다음 줄에 `19,400`. `tokens used: N` 한 줄 형식도 받는다.
 * codex 는 입력/출력 토큰을 나눠 주지 않으므로 합계를 inputTokens 에 넣는다 (capabilities.usageMetadata = false).
 *
 * 주의: stderr 에는 prompt 가 그대로 echo 된다. 문서가 `model:` 줄을 위조할 수 있으므로
 * model 은 헤더 구간(앞부분)에서만 찾고, token 수는 마지막 등장을 쓴다.
 */
export function parseCodexHeader(stdout: string, stderr = ""): CodexHeader {
  let model: string | null = null;
  for (const source of [stderr, stdout]) {
    if (!source) continue;
    const match = /^\s*model:\s*(\S+)\s*$/m.exec(source.slice(0, 1200));
    if (match?.[1]) {
      model = match[1];
      break;
    }
  }
  const combined = `${stderr}\n${stdout}`;
  let inputTokens = 0;
  let outputTokens = 0;
  const detailed = [...combined.matchAll(/tokens\s+used[^\n]*?input[^\d]*([\d,]+)[^\n]*?output[^\d]*([\d,]+)/gi)].at(-1);
  if (detailed) {
    inputTokens = toInt(detailed[1]);
    outputTokens = toInt(detailed[2]);
  } else {
    const total = [...combined.matchAll(/tokens\s+used[:\s]*\r?\n?\s*([\d,]+)/gi)].at(-1);
    if (total) inputTokens = toInt(total[1]);
  }
  return { model, inputTokens, outputTokens };
}

function toInt(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value.replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** 프로세스를 띄우지 못한 경우의 Node 오류 메시지 (비신뢰 내용 없음). */
  spawnError: string | null;
}

export class CodexCliProvider implements LlmProvider {
  readonly id = "codex-cli";
  private readonly workDir: string;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly reasoningEffort: string | undefined;
  private readonly spawnImpl: SpawnCodex;
  private readonly logger: Logger | undefined;

  constructor(options: CodexCliProviderOptions) {
    this.workDir = options.workDir;
    this.spawnImpl = options.spawnImpl ?? ((command, args, opts) => nodeSpawn(command, args, opts) as unknown as CodexProcess);
    this.binary = options.binary ?? "codex";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraArgs = options.extraArgs ?? [];
    this.reasoningEffort = options.reasoningEffort;
    this.logger = options.logger;
  }

  capabilities(_model: string): LlmCapabilities {
    return {
      structuredOutput: true,
      // 분석 task 는 tool calling 을 쓰지 않는다 (INTEGRATIONS_AND_SAFETY.md §3).
      toolCalling: false,
      maxContextTokens: 200_000,
      reasoning: true,
      usageMetadata: false,
    };
  }

  async complete(req: LlmRequest, model: string, signal: AbortSignal): Promise<LlmResponse> {
    const prompt = buildPrompt(req);
    const tempDir = path.join(this.workDir, ".codex-tmp", randomUUID());
    const schemaPath = path.join(tempDir, "schema.json");
    const outPath = path.join(tempDir, "out.json");
    const startedAt = Date.now();
    this.logger?.info("codex exec start", {
      provider: this.id,
      model,
      task: req.task,
      promptId: req.promptId,
      promptVersion: req.promptVersion,
      promptChars: prompt.length,
      untrustedItems: req.untrusted.length,
    });
    try {
      await mkdir(tempDir, { recursive: true });
      await writeFile(schemaPath, JSON.stringify(req.outputSchema), "utf8");

      let run = await this.runCodex(
        buildCodexArgs({
          workDir: this.workDir,
          schemaPath,
          outPath,
          model,
          extraArgs: this.extraArgs,
          reasoningEffort: this.reasoningEffort,
        }),
        prompt,
        signal,
      );
      if (
        run.exitCode !== 0 &&
        run.spawnError === null &&
        !run.timedOut &&
        !run.aborted &&
        this.reasoningEffort !== undefined
      ) {
        // 설정 플래그를 거부하는 codex 버전 대비 1회 재시도 (best effort).
        this.logger?.warn("codex exec retry without reasoning effort flag", { provider: this.id, model });
        run = await this.runCodex(
          buildCodexArgs({
            workDir: this.workDir,
            schemaPath,
            outPath,
            model,
            extraArgs: this.extraArgs,
            reasoningEffort: undefined,
          }),
          prompt,
          signal,
        );
      }

      const latencyMs = Date.now() - startedAt;
      if (run.spawnError !== null) {
        // Windows 에서는 `codex` 가 .cmd/.ps1 shim 이라 shell 없이 실행되지 않는다.
        // composition root 가 codex.exe 경로나 `node <codex.js>` 를 실행하는 spawnImpl 을 넘겨야 한다.
        throw new CodexCliError(
          `codex could not be started (${this.binary}): ${run.spawnError}`,
          run.exitCode,
          tail(run.stderr),
        );
      }
      if (run.aborted) throw new CodexCliError("codex exec aborted", run.exitCode, tail(run.stderr));
      if (run.timedOut) throw new CodexCliError(`codex exec timed out after ${this.timeoutMs}ms`, run.exitCode, tail(run.stderr));
      if (run.exitCode !== 0) {
        throw new CodexCliError(`codex exec failed with exit code ${String(run.exitCode)}`, run.exitCode, tail(run.stderr));
      }

      let raw: string;
      try {
        raw = await readFile(outPath, "utf8");
      } catch {
        // codex 는 최종 JSON 을 stdout 에도 쓴다. 파일이 없으면 그것으로 대체한다.
        if (run.stdout.trim()) raw = run.stdout.trim();
        else throw new CodexCliError("codex exec produced no output file", run.exitCode, tail(run.stderr));
      }
      let json: unknown;
      try {
        json = JSON.parse(raw) as unknown;
      } catch {
        throw new CodexCliError("codex exec output was not valid JSON", run.exitCode, tail(run.stderr));
      }
      const header = parseCodexHeader(run.stdout, run.stderr);
      this.logger?.info("codex exec done", {
        provider: this.id,
        model: header.model ?? model,
        task: req.task,
        latencyMs,
        outputChars: raw.length,
      });
      return {
        json,
        raw,
        usage: {
          inputTokens: header.inputTokens,
          outputTokens: header.outputTokens,
          costUsd: null,
          latencyMs,
        },
        model: header.model ?? model,
        provider: this.id,
        finishReason: "stop",
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private runCodex(args: string[], prompt: string, signal: AbortSignal): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = signal.aborted;
      let settled = false;
      let spawnError: string | null = null;

      const launch = this.binary.toLowerCase().endsWith(".js")
        ? { command: process.execPath, args: [this.binary, ...args] }
        : { command: this.binary, args };
      const child = this.spawnImpl(launch.command, launch.args, {
        cwd: this.workDir,
        // prompt 는 stdin 으로 보낸다 (인자로 넘기지 않는다). 다 쓰면 곧바로 닫아 codex 가 멈추지 않게 한다.
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        aborted = true;
        child.kill();
      };
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve({ exitCode, stdout, stderr, timedOut, aborted, spawnError });
      };

      // 핸들러를 먼저 등록한 뒤에만 kill 한다 (kill 이 즉시 close 를 부르는 경우 대비).
      child.stdout?.on("data", (chunk) => {
        stdout += decode(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += decode(chunk);
      });
      child.on("error", (error) => {
        spawnError = error.message;
        finish(null);
      });
      child.on("close", (code) => {
        finish(code);
      });

      // prompt 는 argv 가 아니라 stdin 으로 흘려보낸다. EPIPE 는 close/error 가 이미 처리한다.
      const stdin = child.stdin;
      if (stdin) {
        stdin.on("error", () => undefined);
        stdin.write(prompt, "utf8");
        stdin.end();
      }

      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);
      if (signal.aborted) child.kill();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function decode(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return String(chunk);
}

function tail(text: string): string {
  return text.length > 400 ? text.slice(text.length - 400) : text;
}
