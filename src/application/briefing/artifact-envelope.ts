/** DailyBriefBody → Artifact 봉투 (CONTRACTS_AND_DATA.md §5.1). 순수 함수. */
import type { Artifact } from "../../domain/artifacts/artifact.js";
import { contentHashOf } from "../../domain/artifacts/artifact.js";
import type { DailyBriefBody } from "../../domain/artifacts/daily-brief.js";
import type { Visibility } from "../../domain/evidence/claim.js";
import type { TimeWindow } from "../../domain/shared/time.js";
import { artifactId } from "../../domain/shared/ids.js";

export interface DailyBriefArtifactInput {
  /** targetKey 이자 artifact id 의 근거가 되는 날짜 (YYYY-MM-DD) */
  date: string;
  body: DailyBriefBody;
  inputs: Artifact<DailyBriefBody>["inputs"];
  visibility: Visibility;
  timezone: string;
  window: TimeWindow;
  createdAt: string;
}

/** revision 은 0 으로 두고 ArtifactStore 가 확정한다 (run-daily-pipeline 의 input 단계). */
export function dailyBriefArtifact(input: DailyBriefArtifactInput): Artifact<DailyBriefBody> {
  return {
    schemaVersion: 1,
    id: artifactId("DAILY_BRIEF", input.date),
    type: "DAILY_BRIEF",
    targetKey: input.date,
    revision: 0,
    contentHash: contentHashOf(input.body),
    status: "FINAL",
    timezone: input.timezone,
    window: input.window,
    body: input.body,
    inputs: input.inputs,
    visibility: input.visibility,
    createdAt: input.createdAt,
  };
}
