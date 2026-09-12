/**
 * 레거시 DailyBriefing (암묵 v1, 현재 data/daily-brief.json 형식) 파서와 v1 → v2 upcast.
 * MIGRATION_AND_ACCEPTANCE.md §3.2
 */
import { Issues, isHttpUrl, isRecord, stringArray } from "../shared/validation.js";
import { isValidCalendarDate } from "../shared/time.js";
import { briefItemId, documentId } from "../shared/ids.js";
import { canonicalUrl } from "../documents/normalized-document.js";
import {
  DAILY_BRIEF_TITLE,
  KNOWLEDGE_TYPES,
  type ApplyCandidate,
  type BriefItem,
  type DailyBriefBody,
  type KnowledgeType,
  type SourceRef,
} from "./daily-brief.js";

export interface BriefingSourceV1 {
  title: string;
  url: string;
}

export interface BriefingTopicV1 {
  id: string;
  title: string;
  type: string;
  importance: number;
  whatChanged: string;
  whyItMatters: string;
  howDevelopersUseIt: string;
  howToApply: string;
  related: string[];
  sources: BriefingSourceV1[];
}

export interface DailyBriefingV1 {
  date: string;
  title: string;
  summary: string[];
  topics: BriefingTopicV1[];
}

const EMPTY = "내용 없음";

function optionalText(obj: Record<string, unknown>, key: string, path: string, fallback: string, issues: Issues): string {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    issues.push(`${path}.${key} must be a string`);
    return fallback;
  }
  return value.trim() || fallback;
}

export function parseDailyBriefingV1(value: unknown): DailyBriefingV1 {
  const issues = new Issues("DailyBriefing v1");
  if (!isRecord(value)) {
    issues.push("root must be a JSON object");
    issues.throwIfAny();
  }
  const obj = value as Record<string, unknown>;
  const date = optionalText(obj, "date", "root", "", issues);
  if (!date || !isValidCalendarDate(date)) issues.push("root.date must be a valid date in YYYY-MM-DD format");
  const topics: BriefingTopicV1[] = [];
  const topicValues = obj.topics ?? [];
  if (!Array.isArray(topicValues)) {
    issues.push("root.topics must be an array");
  } else {
    topicValues.forEach((raw, index) => {
      const path = `topics[${index}]`;
      if (!isRecord(raw)) {
        issues.push(`${path} must be an object`);
        return;
      }
      const id = optionalText(raw, "id", path, `topic-${index + 1}`, issues);
      let importance = 3;
      const imp = raw.importance;
      if (imp !== undefined && imp !== null) {
        if (typeof imp !== "number" || !Number.isInteger(imp) || imp < 1 || imp > 5) {
          issues.push(`${path}.importance must be an integer from 1 to 5`);
        } else importance = imp;
      }
      const sources: BriefingSourceV1[] = [];
      const sourceValues = raw.sources ?? [];
      if (!Array.isArray(sourceValues)) issues.push(`${path}.sources must be an array`);
      else
        sourceValues.forEach((s, si) => {
          const sp = `${path}.sources[${si}]`;
          if (!isRecord(s)) {
            issues.push(`${sp} must be an object`);
            return;
          }
          const title = optionalText(s, "title", sp, "Source", issues);
          const url = optionalText(s, "url", sp, "", issues);
          if (!url) return;
          if (!isHttpUrl(url)) issues.push(`${sp}.url must be a valid http(s) URL`);
          sources.push({ title, url });
        });
      topics.push({
        id,
        title: optionalText(raw, "title", path, id, issues),
        type: optionalText(raw, "type", path, "note", issues),
        importance,
        whatChanged: optionalText(raw, "whatChanged", path, EMPTY, issues),
        whyItMatters: optionalText(raw, "whyItMatters", path, EMPTY, issues),
        howDevelopersUseIt: optionalText(raw, "howDevelopersUseIt", path, EMPTY, issues),
        howToApply: optionalText(raw, "howToApply", path, EMPTY, issues),
        related: stringArray(raw.related, `${path}.related`, issues),
        sources,
      });
    });
  }
  const briefing: DailyBriefingV1 = {
    date,
    title: optionalText(obj, "title", "root", DAILY_BRIEF_TITLE, issues),
    summary: stringArray(obj.summary, "root.summary", issues),
    topics,
  };
  issues.throwIfAny();
  return briefing;
}

export function isV1Briefing(value: unknown): boolean {
  return isRecord(value) && value.bodySchemaVersion === undefined && Array.isArray(value.topics);
}

function knowledgeTypeOf(type: string): KnowledgeType | null {
  const t = type.trim().toLowerCase();
  return (KNOWLEDGE_TYPES as readonly string[]).includes(t) ? (t as KnowledgeType) : null;
}

export const MANUAL_SOURCE_ID = "manual-json";

/** v1 → v2. artifactId 는 item id 계산에 쓰인다. */
export function upcastV1ToDailyBriefBody(v1: DailyBriefingV1, artifactIdValue: string): DailyBriefBody {
  const items: BriefItem[] = v1.topics.map((t) => {
    const sourceRefs: SourceRef[] = t.sources.map((s) => {
      const canonical = canonicalUrl(s.url) ?? s.url;
      return {
        documentId: documentId(MANUAL_SOURCE_ID, canonical),
        title: s.title,
        url: s.url,
        sourceId: MANUAL_SOURCE_ID,
        publishedAt: null,
      };
    });
    return {
      id: briefItemId(artifactIdValue, t.id),
      title: t.title,
      importance: t.importance as 1 | 2 | 3 | 4 | 5,
      whatChanged: t.whatChanged,
      whyItMatters: t.whyItMatters,
      howDevelopersUseIt: t.howDevelopersUseIt === EMPTY ? null : t.howDevelopersUseIt,
      howToApply: t.howToApply === EMPTY ? null : t.howToApply,
      claimIds: [],
      entityIds: [],
      trend: null,
      sourceRefs,
      rankingTrace: { policyId: "manual", policyVersion: "0", score: t.importance, reasons: ["manual input"] },
      knowledgeType: knowledgeTypeOf(t.type),
      related: t.related,
    };
  });
  const best = [...items].sort((a, b) => b.importance - a.importance)[0] ?? null;
  const applyCandidates: ApplyCandidate[] = items
    .filter((i) => i.howToApply)
    .map((i) => ({ itemId: i.id, action: i.howToApply!, effort: "M", prerequisites: [] }));
  const sources = new Map<string, SourceRef>();
  for (const i of items) for (const s of i.sourceRefs) sources.set(s.documentId, s);
  return {
    bodySchemaVersion: 2,
    date: v1.date,
    title: v1.title,
    oneMinuteSummary: v1.summary,
    sections: items.length ? [{ kind: "AI_CODING", items, report: null }] : [],
    learnOneThing: best,
    applyCandidates,
    sources: [...sources.values()],
    coverage: { sourcesAttempted: [MANUAL_SOURCE_ID], sourcesFailed: [], partial: false, note: null },
    digest: null,
  };
}
