/**
 * Hacker News 제목 필터용 AI 관련 키워드.
 *
 * 이 목록은 정책 상수(신뢰 데이터)이며, 외부에서 수집한 문자열은 절대 여기에 들어가지 않는다.
 * 단어 경계로 매칭하고, 단일 낱말은 복수형(`-s`)까지 허용한다.
 */
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
