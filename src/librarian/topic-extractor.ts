import type { BriefingTopic, DailyBriefing } from "../schemas/briefing.js";

export interface TopicExtractor {
  extract(briefing: DailyBriefing): Promise<readonly BriefingTopic[]>;
}
