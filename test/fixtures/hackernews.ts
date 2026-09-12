import type { HttpResponse } from "../../src/ports/system/index.js";
import { jsonResponse } from "../helpers/fake-system.js";

/**
 * Hacker News Firebase API fixture (https://github.com/HackerNews/API).
 * 손으로 줄인 응답이며, 테스트 중 네트워크를 쓰지 않는다.
 */
const API_BASE = "https://hacker-news.firebaseio.com/v0";
export const HN_TOP_STORIES_URL = `${API_BASE}/topstories.json`;
export const hnItemUrl = (id: number): string => `${API_BASE}/item/${id}.json`;

function unix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** 테스트가 쓰는 기본 window: 2026-09-12 00:00Z ~ 12:00Z */
export const HN_WINDOW = { start: "2026-09-12T00:00:00.000Z", end: "2026-09-12T12:00:00.000Z" };

export const HN_STORY_ID = 41000001;
export const HN_TEXT_STORY_ID = 41000003;
export const HN_MCP_STORY_ID = 41000007;

export const HN_TOP_STORIES: number[] = [
  HN_STORY_ID,
  41000002,
  HN_TEXT_STORY_ID,
  41000004,
  41000005,
  41000006,
  HN_MCP_STORY_ID,
];

export const HN_ITEMS: Record<number, unknown> = {
  // AI 관련, window 안, 링크 + 댓글
  [HN_STORY_ID]: {
    id: HN_STORY_ID,
    type: "story",
    by: "alice",
    time: unix("2026-09-12T06:00:00Z"),
    title: "Claude Opus 5 ships a 1M token context window",
    url: "https://example.com/claude-opus-5",
    score: 412,
    descendants: 87,
    kids: [41000101, 41000102, 41000103],
  },
  // AI 키워드 없음 → 제외
  41000002: {
    id: 41000002,
    type: "story",
    by: "baker",
    time: unix("2026-09-12T07:00:00Z"),
    title: "A new sourdough starter technique",
    url: "https://example.com/sourdough",
    score: 88,
    descendants: 12,
  },
  // 본문(text)이 있는 Ask HN → EXCERPT
  [HN_TEXT_STORY_ID]: {
    id: HN_TEXT_STORY_ID,
    type: "story",
    by: "carol",
    time: unix("2026-09-12T08:30:00Z"),
    title: "Ask HN: LLM inference on a Raspberry Pi",
    text: "<p>We ran a 7B model on a Pi 5 &amp; measured 3.4 tok/s.</p><p>Notes: <a href=\"https://example.org/pi-llm\">writeup</a></p>",
    score: 120,
    descendants: 30,
  },
  // AI 관련이지만 window 밖 → 제외
  41000004: {
    id: 41000004,
    type: "story",
    by: "dave",
    time: unix("2026-09-10T09:00:00Z"),
    title: "OpenAI releases a new agent framework",
    url: "https://example.com/agent-framework",
    score: 300,
    descendants: 55,
  },
  // 삭제된 항목 → 제외
  41000005: { id: 41000005, deleted: true },
  // story 가 아님 → 제외
  41000006: {
    id: 41000006,
    type: "job",
    by: "recruiter",
    time: unix("2026-09-12T09:00:00Z"),
    title: "Hiring: LLM infrastructure engineer",
    url: "https://example.com/jobs/llm",
    score: 1,
  },
  // Atom fixture 와 제목이 같다 (SAME_STORY 용). URL 은 다르다.
  [HN_MCP_STORY_ID]: {
    id: HN_MCP_STORY_ID,
    type: "story",
    by: "erin",
    time: unix("2026-09-12T05:30:00Z"),
    title: "Model Context Protocol turns one",
    url: "https://news.example.net/mcp-anniversary",
    score: 210,
    descendants: 41,
  },
  41000101: {
    id: 41000101,
    type: "comment",
    by: "bob",
    parent: HN_STORY_ID,
    time: unix("2026-09-12T06:10:00Z"),
    text: "<p>Impressive numbers. I&#x27;m curious about latency.</p>",
  },
  41000102: {
    id: 41000102,
    type: "comment",
    by: "dana",
    parent: HN_STORY_ID,
    time: unix("2026-09-12T06:20:00Z"),
    text: "Benchmarks or it didn&#39;t happen.",
  },
  41000103: { id: 41000103, type: "comment", parent: HN_STORY_ID, deleted: true },
};

/** url → 응답. FakeHttp 에 그대로 넣는다. */
export function hackerNewsRoutes(topStories: number[] = HN_TOP_STORIES): Record<string, HttpResponse> {
  const routes: Record<string, HttpResponse> = {
    [HN_TOP_STORIES_URL]: jsonResponse(topStories),
  };
  for (const [id, item] of Object.entries(HN_ITEMS)) {
    routes[hnItemUrl(Number(id))] = jsonResponse(item);
  }
  return routes;
}
