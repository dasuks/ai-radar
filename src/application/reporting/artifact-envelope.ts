/**
 * SectionReportBody / DailyDigestBody → Artifact 봉투 (CONTRACTS_AND_DATA.md §5.1, §9). 순수 함수.
 * revision 은 0 으로 두고 ArtifactStore 가 확정한다 (briefing/artifact-envelope.ts 와 같은 규칙).
 */
import type { Artifact } from "../../domain/artifacts/artifact.js";
import { contentHashOf } from "../../domain/artifacts/artifact.js";
import {
  sectionReportTargetKey,
  type DailyDigestBody,
  type SectionReportBody,
} from "../../domain/artifacts/section-report.js";
import type { Visibility } from "../../domain/evidence/claim.js";
import type { TimeWindow } from "../../domain/shared/time.js";
import { artifactId } from "../../domain/shared/ids.js";

export interface ReportArtifactInput<TBody> {
  body: TBody;
  inputs: Artifact<TBody>["inputs"];
  visibility: Visibility;
  timezone: string;
  window: TimeWindow;
  createdAt: string;
}

/** targetKey = `${date}:${section}` (§9 idempotency). */
export function sectionReportArtifact(input: ReportArtifactInput<SectionReportBody>): Artifact<SectionReportBody> {
  const targetKey = sectionReportTargetKey(input.body.date, input.body.section);
  return {
    schemaVersion: 1,
    id: artifactId("SECTION_REPORT", targetKey),
    type: "SECTION_REPORT",
    targetKey,
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

/** targetKey = date. */
export function digestArtifact(input: ReportArtifactInput<DailyDigestBody>): Artifact<DailyDigestBody> {
  return {
    schemaVersion: 1,
    id: artifactId("DAILY_DIGEST", input.body.date),
    type: "DAILY_DIGEST",
    targetKey: input.body.date,
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
