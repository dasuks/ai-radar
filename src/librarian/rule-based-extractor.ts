import type { DailyBriefing } from "../schemas/briefing.js";
import type { TopicExtractor } from "./topic-extractor.js";

export class RuleBasedTopicExtractor implements TopicExtractor {
  async extract(briefing: DailyBriefing) {
    return briefing.topics;
  }
}
