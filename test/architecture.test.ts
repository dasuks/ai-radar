/**
 * 아키텍처 규칙(import 스캔) 테스트.
 *
 * `docs/architecture/ARCHITECTURE.md` §3.1 (계층별 책임과 금지 사항) 과
 * `docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §7.1 (Import 규칙 테스트, ARCH-01..ARCH-10, LEGACY)
 * 이 이 규칙들의 단일 진실(source of truth)이다. 이 파일은 그 표를 강제할 뿐이며,
 * 표가 바뀌면 이 파일을 같이 고쳐 동기 상태를 유지한다(keep this file in sync).
 *
 * 규칙 요약:
 *   ARCH-01 domain/  : node:fs|http|https|child_process|sqlite, 외부 패키지, process.env 금지
 *   ARCH-02 domain/  : application|ports|adapters|runtime|policies (및 layer 밖 legacy) import 금지
 *   ARCH-03 policies/: domain/ (+ policies/ 내부) 외 import 금지, domain 금지 목록 전부 상속
 *   ARCH-04 application/: adapters|runtime import 금지, 외부 SDK·node:fs·process.env 금지
 *   ARCH-05 ports/   : domain/ (+ ports/ 내부) 외 import 금지 (외부 SDK 타입 누출 방지)
 *   ARCH-06 adapters/<a>: 다른 adapters/<b> (b !== "shared"), application|runtime import 금지, process.env 금지
 *   ARCH-07 process.env 문자열은 src/runtime/config/** 에서만
 *   ARCH-08 child_process import는 src/adapters/sources/horizon/** 과 src/adapters/llm/codex-cli/** 에서만
 *   ARCH-09 application/{analyze,trend,briefing}/**: ports/publishing, ports/system/http import 금지
 *   ARCH-10 domain|application|ports 에 Horizon 식별자(horizon, ContentItem) 등장 금지
 *   LEGACY  allowlist 파일은 ARCH 규칙 면제. layer 밖 신규 파일 금지.
 *           allowlist에 있으나 디스크에 없는 항목은 실패(Phase 1 정리 강제)
 */

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

// ---------------------------------------------------------------------------
// 규칙 엔진 (pure)
// ---------------------------------------------------------------------------

const LAYERS = [
  "domain",
  "policies",
  "application",
  "ports",
  "adapters",
  "runtime",
] as const;

type Layer = (typeof LAYERS)[number];

export interface Violation {
  readonly rule: string;
  /** src/ 기준 상대 경로 (forward slash) */
  readonly file: string;
  /** 위반을 만든 import 지정자 또는 텍스트 */
  readonly offender: string;
  readonly message: string;
}

/** domain/policies 에서 금지된 node 내장 모듈 (I/O·프로세스·DB) */
const IO_BUILTINS = new Set(["fs", "http", "https", "child_process", "sqlite"]);

/** §7.1 이 명시적으로 나열한 외부 패키지 (메시지에 근거로 쓴다) */
const NAMED_EXTERNAL_SDKS = ["@notionhq/", "@anthropic-ai/", "openai", "dotenv"];

const HORIZON_IDENTIFIERS = [/\bhorizon\b/i, /\bContentItem\b/i] as const;

type ImportTarget =
  | { readonly kind: "builtin"; readonly module: string; readonly base: string }
  | { readonly kind: "external"; readonly module: string }
  /** src/ 안쪽 파일 (src/ 기준 상대 경로) */
  | { readonly kind: "internal"; readonly path: string }
  /** src/ 밖으로 벗어난 상대 경로 */
  | { readonly kind: "outside"; readonly path: string };

const IMPORT_PATTERNS: readonly RegExp[] = [
  // import x from "m" / export { x } from "m" / export * from "m"
  /\bfrom\s*["']([^"']+)["']/g,
  // import "m"
  /\bimport\s*["']([^"']+)["']/g,
  // import("m")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** 파일 소스에서 import 지정자를 추출한다 (중복 제거, 등장 순서 유지). */
export function extractImportSpecifiers(source: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match = regex.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined && !seen.has(specifier)) {
        seen.add(specifier);
        found.push(specifier);
      }
      match = regex.exec(source);
    }
  }
  return found;
}

/** src/ 기준 상대 경로의 첫 세그먼트를 계층으로 해석한다. layer 밖이면 null(legacy). */
function layerOf(file: string): Layer | null {
  const segments = file.split("/");
  const first = segments[0];
  if (first === undefined || segments.length < 2) return null;
  return (LAYERS as readonly string[]).includes(first) ? (first as Layer) : null;
}

/** adapters/<group>/... 의 group 이름 */
function adapterGroupOf(file: string): string | null {
  const segments = file.split("/");
  if (segments[0] !== "adapters") return null;
  return segments[1] ?? null;
}

function classifySpecifier(fromFile: string, specifier: string): ImportTarget {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = path.posix.join(path.posix.dirname(fromFile), specifier);
    if (resolved === ".." || resolved.startsWith("../")) {
      return { kind: "outside", path: resolved };
    }
    return { kind: "internal", path: resolved };
  }
  const withoutPrefix = specifier.startsWith("node:")
    ? specifier.slice("node:".length)
    : specifier;
  const base = withoutPrefix.split("/")[0] ?? withoutPrefix;
  if (specifier.startsWith("node:") || IO_BUILTINS.has(base)) {
    return { kind: "builtin", module: specifier, base };
  }
  return { kind: "external", module: specifier };
}

function describeTarget(target: ImportTarget): string {
  return target.kind === "internal" || target.kind === "outside"
    ? target.path
    : target.module;
}

function isNamedSdk(module: string): boolean {
  return NAMED_EXTERNAL_SDKS.some(
    (name) => module === name || module.startsWith(name),
  );
}

function makeViolation(rule: string, file: string, offender: string, reason: string): Violation {
  return {
    rule,
    file,
    offender,
    message: `[${rule}] src/${file}: ${reason} (offending: ${offender})`,
  };
}

/**
 * src 파일 집합에 아키텍처 규칙을 적용한다.
 *
 * @param files src/ 기준 상대 경로(forward slash) → 파일 소스 텍스트
 * @param allowlist Phase 1 이전까지 허용되는 legacy 파일 경로 (src/ 기준)
 */
export function evaluateArchitecture(
  files: Map<string, string>,
  allowlist: string[],
): Violation[] {
  const violations: Violation[] = [];
  const allowed = new Set(allowlist);

  // LEGACY: allowlist에 있으나 디스크에 없는 항목 → 정리 강제
  for (const entry of allowlist) {
    if (!files.has(entry)) {
      violations.push(
        makeViolation(
          "LEGACY",
          entry,
          entry,
          "allowlist entry no longer exists on disk; remove it from LEGACY_ALLOWLIST in test/architecture.test.ts",
        ),
      );
    }
  }

  for (const [file, source] of files) {
    if (allowed.has(file)) continue; // (a) allowlist는 ARCH 규칙 면제

    const layer = layerOf(file);
    if (layer === null) {
      // (b) layer 밖 신규 파일 금지
      violations.push(
        makeViolation(
          "LEGACY",
          file,
          file,
          `new files must live in a layer directory (${LAYERS.join(", ")})`,
        ),
      );
    }

    const specifiers = extractImportSpecifiers(source);
    const targets = specifiers.map((specifier) => ({
      specifier,
      target: classifySpecifier(file, specifier),
    }));

    // --- ARCH-07: process.env 는 runtime/config 에서만 -----------------------
    const envMatch = /process\.env(?:\.[A-Za-z_$][\w$]*)?/.exec(source);
    const usesProcessEnv = envMatch !== null;
    const envText = envMatch?.[0] ?? "process.env";
    if (usesProcessEnv && !file.startsWith("runtime/config/")) {
      violations.push(
        makeViolation(
          "ARCH-07",
          file,
          envText,
          "process.env may only be referenced in src/runtime/config/**",
        ),
      );
    }

    // --- ARCH-08: child_process 는 adapters/sources/horizon, adapters/llm/codex-cli 에서만 ---
    for (const { specifier, target } of targets) {
      if (target.kind === "builtin" && target.base === "child_process") {
        if (!file.startsWith("adapters/sources/horizon/") && !file.startsWith("adapters/llm/codex-cli/")) {
          violations.push(
            makeViolation(
              "ARCH-08",
              file,
              specifier,
              "child_process may only be imported from src/adapters/sources/horizon/** or src/adapters/llm/codex-cli/**",
            ),
          );
        }
      }
    }

    // --- ARCH-10: Horizon 식별자 누출 ---------------------------------------
    if (layer === "domain" || layer === "application" || layer === "ports") {
      for (const pattern of HORIZON_IDENTIFIERS) {
        const match = pattern.exec(source);
        if (match !== null) {
          violations.push(
            makeViolation(
              "ARCH-10",
              file,
              match[0] ?? pattern.source,
              `Horizon-specific identifier must not appear in ${layer}/ (Horizon types stay inside adapters)`,
            ),
          );
        }
      }
    }

    switch (layer) {
      case "domain": {
        if (usesProcessEnv) {
          violations.push(
            makeViolation("ARCH-01", file, envText, "domain/ must not reference process.env"),
          );
        }
        for (const { specifier, target } of targets) {
          if (target.kind === "builtin" && IO_BUILTINS.has(target.base)) {
            violations.push(
              makeViolation(
                "ARCH-01",
                file,
                specifier,
                "domain/ must not import I/O or database builtins (node:fs, node:http(s), node:child_process, node:sqlite)",
              ),
            );
          } else if (target.kind === "external") {
            violations.push(
              makeViolation(
                "ARCH-01",
                file,
                specifier,
                isNamedSdk(target.module)
                  ? "domain/ must not import external SDKs (@notionhq/*, @anthropic-ai/*, openai, dotenv)"
                  : "domain/ must not import external packages",
              ),
            );
          } else if (target.kind === "internal" && layerOf(target.path) !== "domain") {
            violations.push(
              makeViolation(
                "ARCH-02",
                file,
                describeTarget(target),
                "domain/ may only import domain/ (never application/, ports/, adapters/, runtime/, policies/ or legacy code)",
              ),
            );
          } else if (target.kind === "outside") {
            violations.push(
              makeViolation(
                "ARCH-02",
                file,
                describeTarget(target),
                "domain/ must not import files outside src/",
              ),
            );
          }
        }
        break;
      }

      case "policies": {
        if (usesProcessEnv) {
          violations.push(
            makeViolation("ARCH-03", file, envText, "policies/ must be pure and must not reference process.env"),
          );
        }
        for (const { specifier, target } of targets) {
          if (target.kind === "builtin" && IO_BUILTINS.has(target.base)) {
            violations.push(
              makeViolation("ARCH-03", file, specifier, "policies/ must not import I/O or database builtins"),
            );
          } else if (target.kind === "external") {
            violations.push(
              makeViolation("ARCH-03", file, specifier, "policies/ must not import external packages"),
            );
          } else if (target.kind === "internal") {
            const targetLayer = layerOf(target.path);
            if (targetLayer !== "domain" && targetLayer !== "policies") {
              violations.push(
                makeViolation(
                  "ARCH-03",
                  file,
                  describeTarget(target),
                  "policies/ may only import domain/ (and policies/ itself)",
                ),
              );
            }
          } else if (target.kind === "outside") {
            violations.push(
              makeViolation("ARCH-03", file, describeTarget(target), "policies/ must not import files outside src/"),
            );
          }
        }
        break;
      }

      case "application": {
        if (usesProcessEnv) {
          violations.push(
            makeViolation("ARCH-04", file, envText, "application/ must not reference process.env (inject config instead)"),
          );
        }
        const isRestricted =
          file.startsWith("application/analyze/") ||
          file.startsWith("application/trend/") ||
          file.startsWith("application/briefing/");
        for (const { specifier, target } of targets) {
          if (target.kind === "builtin" && target.base === "fs") {
            violations.push(
              makeViolation("ARCH-04", file, specifier, "application/ must not import node:fs (use a Port)"),
            );
          } else if (target.kind === "external") {
            violations.push(
              makeViolation("ARCH-04", file, specifier, "application/ must not import external SDKs"),
            );
          } else if (target.kind === "internal") {
            const targetLayer = layerOf(target.path);
            if (targetLayer === "adapters" || targetLayer === "runtime") {
              violations.push(
                makeViolation(
                  "ARCH-04",
                  file,
                  describeTarget(target),
                  "application/ must not import adapters/ or runtime/ (depend on ports/ instead)",
                ),
              );
            } else if (
              targetLayer !== "domain" &&
              targetLayer !== "policies" &&
              targetLayer !== "ports" &&
              targetLayer !== "application"
            ) {
              violations.push(
                makeViolation(
                  "ARCH-04",
                  file,
                  describeTarget(target),
                  "application/ may only import domain/, policies/, ports/ and application/",
                ),
              );
            }
            if (
              isRestricted &&
              (target.path.startsWith("ports/publishing") ||
                target.path.startsWith("ports/system/http"))
            ) {
              violations.push(
                makeViolation(
                  "ARCH-09",
                  file,
                  describeTarget(target),
                  "application/{analyze,trend,briefing}/ must not import ports/publishing or ports/system/http (no publishing or network authority for analyzers)",
                ),
              );
            }
          } else if (target.kind === "outside") {
            violations.push(
              makeViolation("ARCH-04", file, describeTarget(target), "application/ must not import files outside src/"),
            );
          }
        }
        break;
      }

      case "ports": {
        for (const { specifier, target } of targets) {
          if (target.kind === "external") {
            violations.push(
              makeViolation(
                "ARCH-05",
                file,
                specifier,
                isNamedSdk(target.module)
                  ? "ports/ must not import external SDKs (provider types must not leak into port signatures)"
                  : "ports/ must not import external packages",
              ),
            );
          } else if (target.kind === "internal") {
            const targetLayer = layerOf(target.path);
            if (targetLayer !== "domain" && targetLayer !== "ports") {
              violations.push(
                makeViolation(
                  "ARCH-05",
                  file,
                  describeTarget(target),
                  "ports/ may only import domain/ (and ports/ itself)",
                ),
              );
            }
          } else if (target.kind === "outside") {
            violations.push(
              makeViolation("ARCH-05", file, describeTarget(target), "ports/ must not import files outside src/"),
            );
          }
        }
        break;
      }

      case "adapters": {
        const group = adapterGroupOf(file);
        if (usesProcessEnv) {
          violations.push(
            makeViolation(
              "ARCH-06",
              file,
              envText,
              "adapters/ must not reference process.env (credentials are constructor arguments)",
            ),
          );
        }
        for (const { target } of targets) {
          if (target.kind !== "internal") {
            if (target.kind === "outside") {
              violations.push(
                makeViolation("ARCH-06", file, describeTarget(target), "adapters/ must not import files outside src/"),
              );
            }
            continue;
          }
          const targetLayer = layerOf(target.path);
          if (targetLayer === "application" || targetLayer === "runtime") {
            violations.push(
              makeViolation(
                "ARCH-06",
                file,
                describeTarget(target),
                "adapters/ must not import application/ or runtime/",
              ),
            );
          } else if (targetLayer === "adapters") {
            const targetGroup = adapterGroupOf(target.path);
            if (targetGroup !== group && targetGroup !== "shared") {
              violations.push(
                makeViolation(
                  "ARCH-06",
                  file,
                  describeTarget(target),
                  `adapters/${group ?? "?"}/ must not import adapters/${targetGroup ?? "?"}/ (lift shared code to domain/ or adapters/shared/)`,
                ),
              );
            }
          } else if (targetLayer !== "domain" && targetLayer !== "ports") {
            violations.push(
              makeViolation(
                "ARCH-06",
                file,
                describeTarget(target),
                "adapters/ may only import domain/, ports/, its own adapter directory and adapters/shared/",
              ),
            );
          }
        }
        break;
      }

      case "runtime":
      case null:
        break;
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// LEGACY allowlist — Phase 1에서 전부 제거되어야 한다 (MIGRATION §4 Phase 1)
// ---------------------------------------------------------------------------

// Phase 1 완료: 레거시 파일이 모두 이동·삭제되어 allowlist 는 비어 있다.
// 새 파일은 반드시 계층 디렉터리(domain/policies/application/ports/adapters/runtime) 안에 있어야 한다.
const LEGACY_ALLOWLIST: string[] = [];

// ---------------------------------------------------------------------------
// 디스크에서 src/**/*.ts 읽기
// ---------------------------------------------------------------------------

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** 컴파일 결과(.test-dist/test/)와 소스(test/) 어디에서 실행되든 프로젝트의 src/ 를 찾는다. */
async function findSrcRoot(): Promise<string> {
  let current = import.meta.dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const srcPath = path.join(current, "src");
    if (
      (await isFile(path.join(current, "package.json"))) &&
      (await isDirectory(srcPath))
    ) {
      return srcPath;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate src/ starting from ${import.meta.dirname}`);
}

async function readSourceFiles(srcRoot: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const relative = path.relative(srcRoot, absolute).split(path.sep).join("/");
        files.set(relative, await readFile(absolute, "utf8"));
      }
    }
  }

  await walk(srcRoot);
  return files;
}

function formatViolations(violations: readonly Violation[]): string {
  return violations.map((violation) => `  ${violation.message}`).join("\n");
}

function rulesOf(violations: readonly Violation[]): string[] {
  return violations.map((violation) => violation.rule);
}

// ---------------------------------------------------------------------------
// 실제 src/ 검사
// ---------------------------------------------------------------------------

describe("아키텍처 규칙 (src/**/*.ts)", () => {
  test("모든 src 파일이 ARCH-01..ARCH-10 과 LEGACY 규칙을 지킨다", async () => {
    const srcRoot = await findSrcRoot();
    const files = await readSourceFiles(srcRoot);
    assert.ok(files.size > 0, `src/ 에서 TypeScript 파일을 찾지 못했다: ${srcRoot}`);

    const violations = evaluateArchitecture(files, LEGACY_ALLOWLIST);
    assert.deepEqual(
      violations,
      [],
      `아키텍처 위반 ${violations.length}건:\n${formatViolations(violations)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 규칙 엔진 self-test (in-memory fake file set)
// ---------------------------------------------------------------------------

describe("evaluateArchitecture self-test", () => {
  const cleanFiles = new Map<string, string>([
    [
      "domain/artifacts/daily-brief.ts",
      `import { createHash } from "node:crypto";\nimport type { Artifact } from "../shared/ids.js";\nexport const version = createHash("sha256");\nexport type Brief = Artifact;\n`,
    ],
    ["domain/shared/ids.ts", `export type Artifact = { id: string };\n`],
    [
      "policies/ranking/v1.ts",
      `import type { Brief } from "../../domain/artifacts/daily-brief.js";\nexport const score = (brief: Brief): number => brief.id.length;\n`,
    ],
    [
      "ports/publishing/publisher.ts",
      `import type { Brief } from "../../domain/artifacts/daily-brief.js";\nexport interface Publisher { publish(brief: Brief): Promise<void>; }\n`,
    ],
    [
      "application/publish/publish-artifact.ts",
      `import type { Publisher } from "../../ports/publishing/publisher.js";\nimport { score } from "../../policies/ranking/v1.js";\nexport const publish = async (p: Publisher) => { void score; await Promise.resolve(); };\n`,
    ],
    [
      "application/briefing/build-daily-brief.ts",
      `import type { Brief } from "../../domain/artifacts/daily-brief.js";\nexport const build = (b: Brief) => b;\n`,
    ],
    [
      "adapters/notion/notion-publisher.ts",
      `import { Client } from "@notionhq/client";\nimport type { Publisher } from "../../ports/publishing/publisher.js";\nimport { redact } from "../shared/redact.js";\nexport class NotionPublisher { constructor(private client: Client) { void redact; } }\n`,
    ],
    ["adapters/shared/redact.ts", `export const redact = (s: string) => s;\n`],
    [
      "adapters/sources/horizon/horizon-source.ts",
      `import { spawn } from "node:child_process";\nexport const run = () => spawn("hz");\n`,
    ],
    [
      "runtime/config/app-config.ts",
      `export const loadConfig = () => ({ token: process.env["NOTION_TOKEN"] ?? "" });\n`,
    ],
    [
      "runtime/cli/daily.ts",
      `import { loadConfig } from "../config/app-config.js";\nimport { publish } from "../../application/publish/publish-artifact.js";\nexport const main = async () => { void loadConfig; void publish; };\n`,
    ],
    ["legacy-entry.ts", `export const shim = 1;\n`],
  ]);

  const cleanAllowlist = ["legacy-entry.ts"];

  test("규칙을 지키는 파일 집합은 위반이 없다", () => {
    const violations = evaluateArchitecture(cleanFiles, cleanAllowlist);
    assert.deepEqual(violations, [], formatViolations(violations));
  });

  const cases: ReadonlyArray<{
    readonly rule: string;
    readonly file: string;
    readonly source: string;
    readonly offender: string;
  }> = [
    {
      rule: "ARCH-01",
      file: "domain/artifacts/daily-brief.ts",
      source: `import { Client } from "@notionhq/client";\nexport type Brief = { client: Client };\n`,
      offender: "@notionhq/client",
    },
    {
      rule: "ARCH-02",
      file: "domain/runs/run.ts",
      source: `import { publish } from "../../application/publish/publish-artifact.js";\nexport const x = publish;\n`,
      offender: "application/publish/publish-artifact.js",
    },
    {
      rule: "ARCH-03",
      file: "policies/ranking/v1.ts",
      source: `import { publish } from "../../application/publish/publish-artifact.js";\nexport const x = publish;\n`,
      offender: "application/publish/publish-artifact.js",
    },
    {
      rule: "ARCH-04",
      file: "application/publish/publish-artifact.ts",
      source: `import { NotionPublisher } from "../../adapters/notion/notion-publisher.js";\nexport const x = NotionPublisher;\n`,
      offender: "adapters/notion/notion-publisher.js",
    },
    {
      rule: "ARCH-05",
      file: "ports/publishing/publisher.ts",
      source: `import type { BlockObjectRequest } from "@notionhq/client";\nexport interface Publisher { blocks: BlockObjectRequest[]; }\n`,
      offender: "@notionhq/client",
    },
    {
      rule: "ARCH-06",
      file: "adapters/notion/notion-publisher.ts",
      source: `import { readVault } from "../obsidian/vault.js";\nexport const x = readVault;\n`,
      offender: "adapters/obsidian/vault.js",
    },
    {
      rule: "ARCH-07",
      file: "runtime/cli/daily.ts",
      source: `export const token = process.env.NOTION_TOKEN;\n`,
      offender: "process.env.NOTION_TOKEN",
    },
    {
      rule: "ARCH-08",
      file: "adapters/sources/rss/rss-source.ts",
      source: `import { spawn } from "node:child_process";\nexport const x = spawn;\n`,
      offender: "node:child_process",
    },
    {
      rule: "ARCH-09",
      file: "application/analyze/extract-claims.ts",
      source: `import type { Publisher } from "../../ports/publishing/publisher.js";\nexport type X = Publisher;\n`,
      offender: "ports/publishing/publisher.js",
    },
    {
      rule: "ARCH-10",
      file: "domain/documents/raw-observation.ts",
      source: `export interface ContentItem { id: string }\n`,
      offender: "ContentItem",
    },
  ];

  for (const { rule, file, source, offender } of cases) {
    test(`${rule} 위반을 잡아낸다 (${file})`, () => {
      const violations = evaluateArchitecture(new Map([[file, source]]), []);
      const matching = violations.filter((violation) => violation.rule === rule);
      assert.equal(
        matching.length > 0,
        true,
        `${rule} 위반을 찾지 못했다. 보고된 규칙: ${rulesOf(violations).join(", ") || "(없음)"}`,
      );
      const first = matching[0];
      assert.ok(first !== undefined);
      assert.equal(first.file, file);
      assert.equal(first.offender, offender);
      assert.match(first.message, new RegExp(`^\\[${rule}\\] src/`));
      assert.ok(first.message.includes(offender), first.message);
    });
  }

  test("LEGACY: layer 밖 신규 파일을 거부한다", () => {
    const violations = evaluateArchitecture(
      new Map([["helpers/slugify.ts", `export const slugify = (s: string) => s;\n`]]),
      [],
    );
    assert.deepEqual(rulesOf(violations), ["LEGACY"]);
    const first = violations[0];
    assert.ok(first !== undefined);
    assert.match(first.message, /new files must live in a layer directory/);
    assert.match(first.message, /src\/helpers\/slugify\.ts/);
  });

  test("LEGACY: allowlist에 있으나 사라진 파일을 실패로 보고한다", () => {
    const violations = evaluateArchitecture(new Map(), ["writers/notion-writer.ts"]);
    assert.deepEqual(rulesOf(violations), ["LEGACY"]);
    const first = violations[0];
    assert.ok(first !== undefined);
    assert.match(first.message, /no longer exists on disk/);
    assert.match(first.message, /LEGACY_ALLOWLIST/);
  });

  test("LEGACY allowlist 파일은 ARCH 규칙에서 면제된다", () => {
    const legacySource = `import { Client } from "@notionhq/client";\nexport const token = process.env.NOTION_TOKEN;\nexport const c = Client;\n`;
    const withAllowlist = evaluateArchitecture(
      new Map([["writers/notion-writer.ts", legacySource]]),
      ["writers/notion-writer.ts"],
    );
    assert.deepEqual(withAllowlist, []);

    const withoutAllowlist = evaluateArchitecture(
      new Map([["writers/notion-writer.ts", legacySource]]),
      [],
    );
    assert.ok(withoutAllowlist.length > 0);
  });
});
