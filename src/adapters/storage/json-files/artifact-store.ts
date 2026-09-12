import type {
  ApprovalRecord,
  Artifact,
  ArtifactHead,
  ArtifactType,
  ChannelId,
  PublicationRecord,
} from "../../../domain/artifacts/artifact.js";
import type { ArtifactStore } from "../../../ports/storage/index.js";
import { readJsonIfExists, segmentsToPath, writeJsonAtomic } from "./json-file.js";

/**
 * JSON 파일 기반 ArtifactStore (Phase 1).
 *
 * 레이아웃:
 *   <dir>/artifacts/<type>/<targetKey>/head.json
 *   <dir>/artifacts/<type>/<targetKey>/rev-<n>.json
 *   <dir>/publications/<artifactId>/<channel>.json      (PublicationRecord 이력 배열)
 *   <dir>/approvals/<artifactId>/<channel>-<revision>.json
 *
 * Phase 2 에서 SQLite 구현으로 교체된다 (같은 Port).
 */
export class JsonFileArtifactStore implements ArtifactStore {
  constructor(private readonly dir: string) {}

  private targetDir(type: ArtifactType, targetKey: string): string {
    return segmentsToPath(this.dir, "artifacts", type, targetKey);
  }

  async head(type: ArtifactType, targetKey: string): Promise<ArtifactHead | null> {
    return readJsonIfExists<ArtifactHead>(segmentsToPath(this.targetDir(type, targetKey), "head.json"));
  }

  async get<T>(type: ArtifactType, targetKey: string, revision: number): Promise<Artifact<T> | null> {
    return readJsonIfExists<Artifact<T>>(segmentsToPath(this.targetDir(type, targetKey), `rev-${revision}.json`));
  }

  /** contentHash 가 현재 head 와 같으면 새 revision 을 만들지 않고 head 를 돌려준다. */
  async putRevision<T>(artifact: Artifact<T>): Promise<ArtifactHead> {
    const currentHead = await this.head(artifact.type, artifact.targetKey);
    if (currentHead) {
      const current = await this.get<T>(artifact.type, artifact.targetKey, currentHead.revision);
      if (current && current.contentHash === artifact.contentHash) return currentHead;
    }
    const directory = this.targetDir(artifact.type, artifact.targetKey);
    await writeJsonAtomic(segmentsToPath(directory, `rev-${artifact.revision}.json`), artifact);
    const head: ArtifactHead = { type: artifact.type, targetKey: artifact.targetKey, revision: artifact.revision };
    await writeJsonAtomic(segmentsToPath(directory, "head.json"), head);
    return head;
  }

  async putApproval(approval: ApprovalRecord): Promise<void> {
    await writeJsonAtomic(
      segmentsToPath(this.dir, "approvals", approval.artifactId, `${approval.channel}-${approval.revision}.json`),
      approval,
    );
  }

  async approval(artifactId: string, revision: number, channel: ChannelId): Promise<ApprovalRecord | null> {
    return readJsonIfExists<ApprovalRecord>(
      segmentsToPath(this.dir, "approvals", artifactId, `${channel}-${revision}.json`),
    );
  }

  async putPublication(record: PublicationRecord): Promise<void> {
    const file = segmentsToPath(this.dir, "publications", record.artifactId, `${record.channel}.json`);
    const history = (await readJsonIfExists<PublicationRecord[]>(file)) ?? [];
    const index = history.findIndex((item) => item.revision === record.revision);
    if (index >= 0) history[index] = record;
    else history.push(record);
    await writeJsonAtomic(file, history);
  }

  async latestPublication(artifactId: string, channel: ChannelId): Promise<PublicationRecord | null> {
    const file = segmentsToPath(this.dir, "publications", artifactId, `${channel}.json`);
    const history = (await readJsonIfExists<PublicationRecord[]>(file)) ?? [];
    let latest: PublicationRecord | null = null;
    for (const record of history) {
      if (latest === null || record.revision >= latest.revision) latest = record;
    }
    return latest;
  }
}
