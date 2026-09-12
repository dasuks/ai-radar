import type { VaultPort } from "../../src/ports/publishing/index.js";
import type { Logger } from "../../src/ports/system/index.js";

/** 테스트용 in-memory VaultPort. 실제 Vault 를 절대 건드리지 않는다. */
export class MemoryVault implements VaultPort {
  readonly root = "/memory-vault";
  readonly files = new Map<string, string>();
  readonly dryRunWrites: { path: string; contents: string }[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [path, contents] of Object.entries(initial)) this.files.set(path, contents);
  }

  async listNotes(folder: string): Promise<string[]> {
    const prefix = `${folder.replace(/\/+$/, "")}/`;
    return [...this.files.keys()].filter((path) => path.startsWith(prefix) && path.toLowerCase().endsWith(".md")).sort();
  }

  async read(relativePath: string): Promise<string | null> {
    return this.files.get(relativePath) ?? null;
  }

  async exists(relativePath: string): Promise<boolean> {
    return this.files.has(relativePath);
  }

  async write(relativePath: string, contents: string, dryRun: boolean): Promise<void> {
    if (dryRun) {
      this.dryRunWrites.push({ path: relativePath, contents });
      return;
    }
    this.files.set(relativePath, contents);
  }
}

/** 출력을 버리는 Logger (테스트 소음 제거). */
export function silentLogger(collected?: string[]): Logger {
  const make = (scope: string): Logger => ({
    info: (message) => collected?.push(`${scope}${message}`),
    warn: (message) => collected?.push(`${scope}${message}`),
    error: (message) => collected?.push(`${scope}${message}`),
    child: (child) => make(`${scope}${child}: `),
  });
  return make("");
}
