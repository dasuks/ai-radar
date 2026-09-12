/**
 * Source 관련성(relevance) 정책 — 제목이 AI 주제로 보이는지 판정한다.
 *
 * Adapter 는 정책을 모른다. Composition Root 가 `looksAiRelated` 를
 * `HackerNewsSource({ isRelevant })` 로 주입한다 (ARCHITECTURE.md §3.1).
 * 이 목록은 정책 상수(신뢰 데이터)이며, 외부에서 수집한 문자열은 절대 여기에 들어가지 않는다.
 * 단어 경계로 매칭하고, 단일 낱말은 복수형(`-s`)까지 허용한다.
 */

export const SOURCE_RELEVANCE_POLICY_ID = "classification.source-relevance";
export const SOURCE_RELEVANCE_POLICY_VERSION = "1.0.0";
export const AI_KEYWORDS: readonly string[] = [
  "ai",
  "agent",
  "agentic",
  "anthropic",
  "chatbot",
  "chatgpt",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "dall-e",
  "deep learning",
  "deepmind",
  "deepseek",
  "diffusion",
  "embedding",
  "fine-tuning",
  "foundation model",
  "gemini",
  "gpt",
  "hugging face",
  "huggingface",
  "inference",
  "language model",
  "llama",
  "llm",
  "machine learning",
  "mcp",
  "mistral",
  "model context protocol",
  "model",
  "multimodal",
  "neural network",
  "openai",
  "prompt",
  "pytorch",
  "quantization",
  "rag",
  "reinforcement learning",
  "retrieval augmented generation",
  "stable diffusion",
  "tokenizer",
  "transformer",
  "vibe coding",
  "coding assistant",
  "coding agent",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(keywords: readonly string[]): RegExp {
  const alternation = keywords.map(escapeRegExp).join("|");
  return new RegExp(`\\b(?:${alternation})s?\\b`, "i");
}

const AI_KEYWORD_PATTERN = buildPattern(AI_KEYWORDS);

/** 제목이 AI 관련으로 보이는가. 순수 함수 (정규식 상수만 사용). */
export function looksAiRelated(title: string): boolean {
  return AI_KEYWORD_PATTERN.test(title);
}
