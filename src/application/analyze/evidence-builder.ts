/**
 * Evidence 후보를 LLM 호출 전에 결정적으로 만든다 (PIPELINES §5.2 2).
 * LLM 은 이 집합 밖의 id 를 쓸 수 없고, 검증 단계가 그것을 강제한다.
 */
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import { evidenceText, makeEvidence, type Evidence } from "../../domain/evidence/evidence.js";

export const MAX_EXCERPT_CHARS = 400;
export const MAX_EXCERPTS_PER_DOCUMENT = 12;
export const MAX_COMMENTS_PER_DOCUMENT = 5;

export interface TextSpan {
  start: number;
  end: number;
  text: string;
}

const PARAGRAPH_BREAK = /\n{2,}/g;
const SENTENCE_END = /[.!?。！？]["'”’)\]]*\s+|\n/g;

/** 문단 → 문장 순서로 쪼개 `maxChars` 이하 span 을 만든다. 오프셋은 원본 content 기준. */
export function splitIntoSpans(content: string, maxChars = MAX_EXCERPT_CHARS, maxSpans = MAX_EXCERPTS_PER_DOCUMENT): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const paragraph of paragraphsOf(content)) {
    if (spans.length >= maxSpans) break;
    for (const span of packSentences(paragraph, maxChars)) {
      if (spans.length >= maxSpans) break;
      spans.push(span);
    }
  }
  return spans;
}

function paragraphsOf(content: string): TextSpan[] {
  const out: TextSpan[] = [];
  let cursor = 0;
  PARAGRAPH_BREAK.lastIndex = 0;
  let match = PARAGRAPH_BREAK.exec(content);
  while (match !== null) {
    pushTrimmed(out, content, cursor, match.index);
    cursor = match.index + match[0].length;
    match = PARAGRAPH_BREAK.exec(content);
  }
  pushTrimmed(out, content, cursor, content.length);
  return out;
}

function pushTrimmed(out: TextSpan[], content: string, start: number, end: number): void {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(content[from] ?? "")) from += 1;
  while (to > from && /\s/.test(content[to - 1] ?? "")) to -= 1;
  if (to <= from) return;
  out.push({ start: from, end: to, text: content.slice(from, to) });
}

/** 한 문단을 문장 단위로 묶어 maxChars 이하로 만든다. 한 문장이 너무 길면 강제로 자른다. */
function packSentences(paragraph: TextSpan, maxChars: number): TextSpan[] {
  if (paragraph.text.length <= maxChars) return [paragraph];
  const out: TextSpan[] = [];
  const sentences: TextSpan[] = [];
  let cursor = 0;
  SENTENCE_END.lastIndex = 0;
  let match = SENTENCE_END.exec(paragraph.text);
  while (match !== null) {
    const end = match.index + match[0].length;
    sentences.push({ start: cursor, end, text: paragraph.text.slice(cursor, end) });
    cursor = end;
    match = SENTENCE_END.exec(paragraph.text);
  }
  if (cursor < paragraph.text.length) {
    sentences.push({ start: cursor, end: paragraph.text.length, text: paragraph.text.slice(cursor) });
  }

  let bufferStart: number | null = null;
  let bufferEnd = 0;
  const flush = (): void => {
    if (bufferStart === null) return;
    pushTrimmed(out, paragraph.text, bufferStart, bufferEnd);
    bufferStart = null;
  };
  for (const sentence of sentences) {
    if (sentence.text.trim().length === 0) continue;
    if (sentence.text.length > maxChars) {
      flush();
      for (let offset = sentence.start; offset < sentence.end; offset += maxChars) {
        pushTrimmed(out, paragraph.text, offset, Math.min(offset + maxChars, sentence.end));
      }
      continue;
    }
    if (bufferStart === null) {
      bufferStart = sentence.start;
      bufferEnd = sentence.end;
      continue;
    }
    if (sentence.end - bufferStart <= maxChars) {
      bufferEnd = sentence.end;
      continue;
    }
    flush();
    bufferStart = sentence.start;
    bufferEnd = sentence.end;
  }
  flush();
  return out.map((span) => ({
    start: paragraph.start + span.start,
    end: paragraph.start + span.end,
    text: span.text,
  }));
}

/** 문서 하나의 Evidence 후보. content 가 없으면 document locator 하나만 만든다. */
export function buildEvidenceForDocument(document: NormalizedDocument): Evidence[] {
  const common = {
    documentId: document.id,
    observationId: document.latestObservationId,
    capturedAt: document.fetchedAt,
    publishedAt: document.publishedAt,
  };
  const out: Evidence[] = [];
  if (document.content && document.content.trim().length > 0) {
    for (const span of splitIntoSpans(document.content)) {
      out.push(makeEvidence({ ...common, locator: { kind: "excerpt", start: span.start, end: span.end, text: span.text } }));
    }
  }
  if (out.length === 0) {
    out.push(makeEvidence({ ...common, locator: { kind: "document" } }));
  }
  let comments = 0;
  for (const comment of document.comments) {
    if (comments >= MAX_COMMENTS_PER_DOCUMENT) break;
    const text = comment.content.trim();
    if (!text) continue;
    out.push(
      makeEvidence({
        ...common,
        locator: {
          kind: "comment",
          commentExternalId: comment.externalId,
          text: text.length > MAX_EXCERPT_CHARS ? text.slice(0, MAX_EXCERPT_CHARS) : text,
        },
      }),
    );
    comments += 1;
  }
  return out;
}

/** prompt 에 넣을 인용 텍스트. document locator 는 제목을 대신 쓴다. */
export function evidencePromptText(evidence: Evidence, document: NormalizedDocument): string {
  if (evidence.locator.kind === "document") return document.title;
  return evidenceText(evidence, document.content);
}
