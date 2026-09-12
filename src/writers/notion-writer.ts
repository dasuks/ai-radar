import {
  Client,
  type BlockObjectRequest,
  type CreatePageParameters,
} from "@notionhq/client";
import type { DailyBriefing } from "../schemas/briefing.js";

const NOTION_API_VERSION = "2026-03-11";
const RICH_TEXT_LIMIT = 2_000;
const RICH_TEXT_ITEMS_LIMIT = 100;
const BLOCKS_PER_REQUEST = 100;
const MULTI_SELECT_NAME_LIMIT = 100;
const MULTI_SELECT_OPTIONS_LIMIT = 100;
const SCHEMA_UNAVAILABLE = "data source schema is unavailable";

const REQUIRED_PROPERTIES = {
  Name: "title",
  Date: "date",
  Topics: "multi_select",
  Importance: "number",
  Read: "checkbox",
  Applied: "checkbox",
} as const;

export type NotionClient = Pick<
  Client,
  "blocks" | "databases" | "dataSources" | "pages" | "search"
>;

export interface NotionWriteOptions {
  token: string;
  databaseId: string;
  client?: NotionClient;
}

export interface NotionWriteResult {
  action: "created" | "updated";
  pageId: string;
}

type PageProperties = NonNullable<CreatePageParameters["properties"]>;
type TextBlockType =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitText(value: string, limit = RICH_TEXT_LIMIT): string[] {
  const text = value || "내용 없음";
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    const lastCodeUnit = text.charCodeAt(end - 1);
    if (end < text.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
}

function richText(content: string, url?: string) {
  return [
    {
      type: "text" as const,
      text: url ? { content, link: { url } } : { content },
    },
  ];
}

function textBlock(
  type: TextBlockType,
  content: string,
  url?: string,
): BlockObjectRequest {
  const blockContent = { rich_text: richText(content, url) };
  switch (type) {
    case "heading_1":
      return { object: "block", type, heading_1: blockContent };
    case "heading_2":
      return { object: "block", type, heading_2: blockContent };
    case "heading_3":
      return { object: "block", type, heading_3: blockContent };
    case "bulleted_list_item":
      return { object: "block", type, bulleted_list_item: blockContent };
    case "paragraph":
      return { object: "block", type, paragraph: blockContent };
  }
}

function textBlocks(
  type: TextBlockType,
  content: string,
  url?: string,
): BlockObjectRequest[] {
  return splitText(content).map((chunk, index) =>
    textBlock(index === 0 ? type : "paragraph", chunk, url),
  );
}

function titleRichText(title: string) {
  const chunks = splitText(title);
  if (chunks.length > RICH_TEXT_ITEMS_LIMIT) {
    throw new Error(
      `Briefing title exceeds Notion's ${RICH_TEXT_ITEMS_LIMIT * RICH_TEXT_LIMIT}-character limit`,
    );
  }
  return chunks.flatMap((chunk) => richText(chunk));
}

function truncateWithoutBreakingSurrogate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function topicNames(briefing: DailyBriefing): string[] {
  const unique = new Set<string>();
  for (const topic of briefing.topics) {
    unique.add(truncateWithoutBreakingSurrogate(topic.title, MULTI_SELECT_NAME_LIMIT));
    if (unique.size === MULTI_SELECT_OPTIONS_LIMIT) break;
  }
  return [...unique];
}

function sharedProperties(briefing: DailyBriefing): PageProperties {
  return {
    Name: { title: titleRichText(briefing.title) },
    Date: { date: { start: briefing.date } },
    Topics: {
      multi_select: topicNames(briefing).map((name) => ({ name })),
    },
    Importance: {
      number: briefing.topics.reduce(
        (highest, topic) => Math.max(highest, topic.importance),
        0,
      ),
    },
  };
}

export function buildNotionBlocks(briefing: DailyBriefing): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [
    ...textBlocks("heading_1", "오늘 이것만 알면 됨"),
  ];

  if (briefing.summary.length === 0) {
    blocks.push(...textBlocks("paragraph", "등록된 요약이 없습니다."));
  } else {
    for (const summary of briefing.summary) {
      blocks.push(...textBlocks("bulleted_list_item", summary));
    }
  }

  if (briefing.topics.length === 0) {
    blocks.push(...textBlocks("paragraph", "오늘 등록된 주제가 없습니다."));
    return blocks;
  }

  for (const topic of briefing.topics) {
    blocks.push(
      { object: "block", type: "divider", divider: {} },
      ...textBlocks("heading_2", topic.title),
      ...textBlocks("paragraph", `중요도: ${topic.importance}/5`),
      ...textBlocks("heading_3", "무엇이 바뀌었나"),
      ...textBlocks("paragraph", topic.whatChanged),
      ...textBlocks("heading_3", "왜 중요한가"),
      ...textBlocks("paragraph", topic.whyItMatters),
      ...textBlocks("heading_3", "실제 개발자들은 어떻게 쓰나"),
      ...textBlocks("paragraph", topic.howDevelopersUseIt),
      ...textBlocks("heading_3", "바로 적용하려면"),
      ...textBlocks("paragraph", topic.howToApply),
      ...textBlocks("heading_3", "관련 개념"),
    );

    if (topic.related.length === 0) {
      blocks.push(...textBlocks("paragraph", "등록된 관련 개념이 없습니다."));
    } else {
      for (const related of topic.related) {
        blocks.push(...textBlocks("bulleted_list_item", related));
      }
    }

    blocks.push(...textBlocks("heading_3", "Sources"));
    if (topic.sources.length === 0) {
      blocks.push(...textBlocks("paragraph", "등록된 출처가 없습니다."));
    } else {
      for (const source of topic.sources) {
        const safeUrl = source.url.length <= RICH_TEXT_LIMIT ? source.url : undefined;
        blocks.push(...textBlocks("bulleted_list_item", source.title, safeUrl));
        if (!safeUrl) blocks.push(...textBlocks("paragraph", source.url));
      }
    }
  }

  return blocks;
}

function schemaIssues(dataSource: unknown): string[] {
  if (!isRecord(dataSource)) {
    return [SCHEMA_UNAVAILABLE];
  }
  const properties = dataSource.properties;
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    return [SCHEMA_UNAVAILABLE];
  }

  return Object.entries(REQUIRED_PROPERTIES).flatMap(([name, expectedType]) => {
    const property = properties[name];
    if (!isRecord(property)) return [`missing property '${name}'`];
    return property.type === expectedType
      ? []
      : [`property '${name}' must be ${expectedType}, got ${String(property.type)}`];
  });
}

async function resolveDataSourceId(
  client: NotionClient,
  databaseId: string,
): Promise<string> {
  let references: Array<{ id: string }> = [];
  try {
    const database = await client.databases.retrieve({ database_id: databaseId });
    if ("data_sources" in database) references = database.data_sources;
  } catch {
    // Search below also supports a configured data source ID.
  }

  if (references.length === 0) {
    const normalizedConfiguredId = databaseId.replaceAll("-", "").toLowerCase();
    const discoveredReferences: Array<{ id: string }> = [];
    let cursor: string | undefined;
    do {
      const response = await client.search({
        filter: { property: "object", value: "data_source" },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const result of response.results) {
        if (result.object !== "data_source") continue;
        discoveredReferences.push({ id: result.id });
        const normalizedResultId = result.id.replaceAll("-", "").toLowerCase();
        const parentDatabaseId =
          "parent" in result && result.parent.type === "database_id"
            ? result.parent.database_id.replaceAll("-", "").toLowerCase()
            : undefined;
        if (
          normalizedResultId === normalizedConfiguredId ||
          parentDatabaseId === normalizedConfiguredId
        ) {
          references.push({ id: result.id });
        }
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    if (references.length === 0) references = discoveredReferences;
  }

  if (references.length === 0) {
    throw new Error(
      "The configured NOTION_DATABASE_ID could not be resolved to an accessible data source",
    );
  }

  const matches: string[] = [];
  const failures: string[] = [];
  for (const reference of references) {
    const dataSource = await client.dataSources.retrieve({
      data_source_id: reference.id,
    });
    const issues = schemaIssues(dataSource);
    if (issues.length === 0) matches.push(reference.id);
    else failures.push(issues.join(", "));
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      "Multiple data sources match the required schema; keep one matching data source in the database",
    );
  }
  if (references.length === 1 && failures[0] === SCHEMA_UNAVAILABLE) {
    return references[0]!.id;
  }
  throw new Error(`Notion database schema mismatch: ${failures.join("; ")}`);
}

async function findPageIdByDate(
  client: NotionClient,
  dataSourceId: string,
  date: string,
): Promise<string | undefined> {
  const response = await client.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: "Date", date: { equals: date } },
    result_type: "page",
    page_size: 100,
  });
  const pages = response.results.filter((result) => result.object === "page");
  if (pages.length > 1) {
    throw new Error(
      `Found ${pages.length} Notion pages for Date ${date}; resolve duplicates before continuing`,
    );
  }
  return pages[0]?.id;
}

async function appendBlocks(
  client: NotionClient,
  pageId: string,
  blocks: BlockObjectRequest[],
): Promise<void> {
  for (let index = 0; index < blocks.length; index += BLOCKS_PER_REQUEST) {
    await client.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(index, index + BLOCKS_PER_REQUEST),
    });
  }
}

export async function writeNotionDailyBrief(
  briefing: DailyBriefing,
  options: NotionWriteOptions,
): Promise<NotionWriteResult> {
  const client =
    options.client ??
    new Client({
      auth: options.token,
      notionVersion: NOTION_API_VERSION,
      logger: () => undefined,
    });
  const dataSourceId = await resolveDataSourceId(client, options.databaseId);
  const existingPageId = await findPageIdByDate(
    client,
    dataSourceId,
    briefing.date,
  );
  const properties = sharedProperties(briefing);
  const blocks = buildNotionBlocks(briefing);

  if (existingPageId) {
    await client.pages.update({
      page_id: existingPageId,
      properties,
      erase_content: true,
    });
    await appendBlocks(client, existingPageId, blocks);
    return { action: "updated", pageId: existingPageId };
  }

  const page = await client.pages.create({
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      ...properties,
      Read: { checkbox: false },
      Applied: { checkbox: false },
    },
  });
  await appendBlocks(client, page.id, blocks);
  return { action: "created", pageId: page.id };
}
