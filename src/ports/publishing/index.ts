import type { Artifact, ChannelId } from "../../domain/artifacts/artifact.js";

/** 렌더 결과. 채널별 형식은 adapter 내부 타입이며 여기서는 opaque 하게 다룬다. */
export interface Rendered {
  channel: ChannelId;
  /** 렌더 결과의 결정적 hash (같은 artifact revision → 같은 hash) */
  hash: string;
  /** 채널 adapter 가 해석하는 payload */
  payload: unknown;
  /** 사람이 읽을 수 있는 미리보기 (dry-run 출력용) */
  preview: string;
}

export interface Renderer<TBody> {
  readonly channel: ChannelId;
  render(artifact: Artifact<TBody>): Rendered;
}

export interface PublishOutcome {
  externalId: string | null;
  externalUrl: string | null;
  action: "created" | "updated" | "skipped";
}

export interface Publisher {
  readonly channel: ChannelId;
  /**
   * 채널로 내보낸다. `existingExternalId` 가 있으면 같은 외부 객체를 갱신한다.
   * 사용자 소유 필드는 절대 덮어쓰지 않는다 (채널별 규칙은 adapter 안에).
   */
  publish(input: { artifactId: string; revision: number; rendered: Rendered; existingExternalId: string | null; dryRun: boolean }): Promise<PublishOutcome>;
  /** 애매한 결과(타임아웃 등) 검증용. 존재하면 id 반환. */
  verify?(externalId: string): Promise<boolean>;
}

/** Obsidian Vault 읽기/쓰기 (INTEGRATIONS §2). 관리 영역 밖 수정 금지는 Use Case 가 보장한다. */
export interface VaultPort {
  readonly root: string;
  /** 폴더 내 .md 파일 목록 (재귀). 경로는 vault 상대 경로. */
  listNotes(folder: string): Promise<string[]>;
  read(relativePath: string): Promise<string | null>;
  write(relativePath: string, contents: string, dryRun: boolean): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
}
