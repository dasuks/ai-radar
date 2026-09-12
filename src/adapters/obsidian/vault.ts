import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { VaultPort } from "../../ports/publishing/index.js";
import type { Logger } from "../../ports/system/index.js";

export interface ObsidianVaultOptions {
  root: string;
  logger?: Logger;
}

/** vault 상대 경로는 항상 "/" 구분자를 쓴다. */
function toRelative(value: string): string {
  return value.split("\\").join("/");
}

/** 경로 탈출 방지 (레거시 assertInsideVault 와 같은 규칙). */
export function assertInsideVault(vaultRoot: string, target: string): void {
  const pathFromVault = relative(resolve(vaultRoot), resolve(target));
  if (
    pathFromVault === "" ||
    pathFromVault === ".." ||
    pathFromVault.startsWith("..\\") ||
    pathFromVault.startsWith("../") ||
    isAbsolute(pathFromVault)
  ) {
    throw new Error(`Refusing to touch a path outside the Obsidian Vault: ${target}`);
  }
}

/** 매우 단순한 줄 단위 diff. dry-run 출력용이며 patch 로 쓰이지 않는다. */
export function unifiedishDiff(before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let head = 0;
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1;
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = beforeLines.slice(head, beforeLines.length - tail);
  const added = afterLines.slice(head, afterLines.length - tail);
  if (removed.length === 0 && added.length === 0) return "  (no change)";
  const lines = [`  @@ line ${head + 1} @@`];
  for (const line of removed) lines.push(`  - ${line}`);
  for (const line of added) lines.push(`  + ${line}`);
  return lines.join("\n");
}

/**
 * Obsidian Vault 를 파일시스템으로 구현한 VaultPort.
 * 관리 영역 밖을 지키는 책임은 Use Case 에 있고, 이 adapter 는 경로 경계와 dry-run 만 담당한다.
 */
export class ObsidianVault implements VaultPort {
  readonly root: string;
  private readonly logger: Logger | undefined;

  constructor(options: ObsidianVaultOptions) {
    this.root = resolve(options.root);
    this.logger = options.logger;
  }

  private absolute(relativePath: string): string {
    const target = resolve(join(this.root, ...toRelative(relativePath).split("/")));
    assertInsideVault(this.root, target);
    return target;
  }

  async listNotes(folder: string): Promise<string[]> {
    const base = this.absolute(folder);
    const out: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          out.push(toRelative(relative(this.root, absolute)));
        }
      }
    };
    await walk(base);
    return out.sort();
  }

  async read(relativePath: string): Promise<string | null> {
    try {
      return await readFile(this.absolute(relativePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    return (await this.read(relativePath)) !== null;
  }

  async write(relativePath: string, contents: string, dryRun: boolean): Promise<void> {
    const target = this.absolute(relativePath);
    if (dryRun) {
      const before = (await this.read(relativePath)) ?? "";
      const logger = this.logger;
      if (logger) {
        logger.info(`dry-run diff: ${relativePath}`);
        for (const line of unifiedishDiff(before, contents).split("\n")) logger.info(line);
      }
      return;
    }
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}
