import { Client, type BlockObjectRequest, type CreatePageParameters } from "@notionhq/client";
import type { ChannelId } from "../../domain/artifacts/artifact.js";
import { isRecord } from "../../domain/shared/validation.js";
import type { PublishOutcome, Publisher, Rendered } from "../../ports/publishing/index.js";
import type { Logger } from "../../ports/system/index.js";

const NOTION_API_VERSION = "2026-03-11";
const BLOCKS_PER_REQUEST = 100;
const SCHEMA_UNAVAILABLE = "data source schema is unavailable";

const REQUIRED_PROPERTIES = {
  Name: "title",
  Date: "date",
  Topics: "multi_select",
  Importance: "number",
  Read: "checkbox",
  Applied: "checkbox",
} as const;

export type NotionClient = Pick<Client, "blocks" | "databases" | "dataSources" | "pages" | "search">;

type PageProperties = NonNullable<CreatePageParameters["properties"]>;

/** NotionBlocksRenderer 의 payload 와 같은 형태. adapter 간 import 금지(ARCH-06)로 여기서 다시 선언한다. */
interface NotionRenderedPayload {
  properties: PageProperties;
  blocks: BlockObjectRequest[];
}

export interface NotionPublisherOptions {
  token: string;
  databaseId: string;
  /** 설정된 data source id. 있으면 자동 탐색을 하지 않는다 */
  dataSourceId?: string | undefined;
  /** 설정 ID 와 무관한 data source 로의 스키마 fallback 허용 여부 (R-N1, 기본 false) */
  allowSchemaFallback: boolean;
  client?: NotionClient;
  logger?: Logger;
}

function normalizeId(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

function schemaIssues(dataSource: unknown): string[] {
  if (!isRecord(dataSource)) return [SCHEMA_UNAVAILABLE];
  const properties = dataSource.properties;
  if (!isRecord(properties) || Object.keys(properties).length === 0) return [SCHEMA_UNAVAILABLE];
  return Object.entries(REQUIRED_PROPERTIES).flatMap(([name, expectedType]) => {
    const property = properties[name];
    if (!isRecord(property)) return [`missing property '${name}'`];
    return property.type === expectedType ? [] : [`property '${name}' must be ${expectedType}, got ${String(property.type)}`];
  });
}

function payloadOf(rendered: Rendered): NotionRenderedPayload {
  const payload = rendered.payload;
  if (!isRecord(payload) || !isRecord(payload.properties) || !Array.isArray(payload.blocks)) {
    throw new Error("Notion publisher received a payload that is not { properties, blocks }");
  }
  return payload as unknown as NotionRenderedPayload;
}

/** Date 속성에서 upsert 키로 쓸 날짜를 꺼낸다. */
function dateOf(properties: PageProperties): string {
  const property = (properties as Record<string, unknown>).Date;
  if (isRecord(property) && isRecord(property.date) && typeof property.date.start === "string") {
    return property.date.start;
  }
  throw new Error("Notion payload is missing the Date property");
}

/**
 * Notion 채널 Publisher (INTEGRATIONS_AND_SAFETY.md §1.3).
 * - 갱신 시 Read/Applied 및 사용자가 추가한 속성은 요청에 넣지 않는다.
 * - Date 로 페이지가 2개 이상이면 중단한다 (자동 삭제·병합 금지).
 * - 설정 ID 와 무관한 data source 로의 fallback 은 opt-in 일 때만 (R-N1).
 */
export class NotionPublisher implements Publisher {
  readonly channel: ChannelId = "notion";
  private readonly client: NotionClient;
  private readonly logger: Logger | undefined;
  private resolvedDataSourceId: string | null = null;

  constructor(private readonly options: NotionPublisherOptions) {
    this.client =
      options.client ??
      new Client({ auth: options.token, notionVersion: NOTION_API_VERSION, logger: () => undefined });
    this.logger = options.logger;
  }

  async publish(input: {
    artifactId: string;
    revision: number;
    rendered: Rendered;
    existingExternalId: string | null;
    dryRun: boolean;
  }): Promise<PublishOutcome> {
    const payload = payloadOf(input.rendered);
    const date = dateOf(payload.properties);
    const dataSourceId = await this.dataSourceId();
    const pageId = await this.findPageId(dataSourceId, date, input.existingExternalId);

    if (input.dryRun) {
      this.logger?.info(
        pageId ? `dry-run: would update page ${pageId}` : "dry-run: would create a new page",
        { date, blocks: payload.blocks.length, revision: input.revision },
      );
      return { externalId: pageId ?? null, externalUrl: null, action: "skipped" };
    }

    if (pageId) {
      await this.client.pages.update({ page_id: pageId, properties: payload.properties, erase_content: true });
      await this.appendBlocks(pageId, payload.blocks);
      return { externalId: pageId, externalUrl: null, action: "updated" };
    }

    const page = await this.client.pages.create({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: {
        ...payload.properties,
        Read: { checkbox: false },
        Applied: { checkbox: false },
      },
    });
    await this.appendBlocks(page.id, payload.blocks);
    return { externalId: page.id, externalUrl: null, action: "created" };
  }

  async verify(externalId: string): Promise<boolean> {
    try {
      await this.client.pages.retrieve({ page_id: externalId });
      return true;
    } catch {
      return false;
    }
  }

  private async dataSourceId(): Promise<string> {
    if (this.resolvedDataSourceId) return this.resolvedDataSourceId;
    const configured = this.options.dataSourceId?.trim();
    if (configured) {
      this.resolvedDataSourceId = configured;
      return configured;
    }
    const resolved = await this.discoverDataSourceId();
    this.resolvedDataSourceId = resolved;
    return resolved;
  }

  private async discoverDataSourceId(): Promise<string> {
    const databaseId = this.options.databaseId;
    let references: Array<{ id: string }> = [];
    try {
      const database = await this.client.databases.retrieve({ database_id: databaseId });
      if ("data_sources" in database) references = database.data_sources;
    } catch {
      // 아래 search 가 configured data source ID 도 처리한다.
    }

    let usedFallback = false;
    if (references.length === 0) {
      const configured = normalizeId(databaseId);
      const discovered: Array<{ id: string }> = [];
      let cursor: string | undefined;
      do {
        const response = await this.client.search({
          filter: { property: "object", value: "data_source" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        for (const result of response.results) {
          if (result.object !== "data_source") continue;
          discovered.push({ id: result.id });
          const parentDatabaseId =
            "parent" in result && result.parent.type === "database_id"
              ? normalizeId(result.parent.database_id)
              : undefined;
          if (normalizeId(result.id) === configured || parentDatabaseId === configured) {
            references.push({ id: result.id });
          }
        }
        cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
      } while (cursor);

      if (references.length === 0) {
        if (!this.options.allowSchemaFallback) {
          throw new Error(
            "The configured NOTION_DATABASE_ID could not be resolved to an accessible data source. " +
              "Refusing to fall back to a schema-matching data source in another database; " +
              "set NOTION_DATA_SOURCE_ID, or set NOTION_ALLOW_SCHEMA_FALLBACK=true to opt in.",
          );
        }
        references = discovered;
        usedFallback = true;
      }
    }

    if (references.length === 0) {
      throw new Error("The configured NOTION_DATABASE_ID could not be resolved to an accessible data source");
    }

    const matches: string[] = [];
    const failures: string[] = [];
    for (const reference of references) {
      const dataSource = await this.client.dataSources.retrieve({ data_source_id: reference.id });
      const issues = schemaIssues(dataSource);
      if (issues.length === 0) matches.push(reference.id);
      else failures.push(issues.join(", "));
    }

    if (matches.length === 1) {
      if (usedFallback) {
        this.logger?.warn("using a schema-matching data source that does not match the configured id (NOTION_ALLOW_SCHEMA_FALLBACK)");
      }
      return matches[0]!;
    }
    if (matches.length > 1) {
      throw new Error("Multiple data sources match the required schema; keep one matching data source in the database");
    }
    if (references.length === 1 && failures[0] === SCHEMA_UNAVAILABLE) return references[0]!.id;
    throw new Error(`Notion database schema mismatch: ${failures.join("; ")}`);
  }

  private async findPageId(
    dataSourceId: string,
    date: string,
    existingExternalId: string | null,
  ): Promise<string | undefined> {
    if (existingExternalId) {
      if (await this.verify(existingExternalId)) return existingExternalId;
      this.logger?.warn(`recorded Notion page ${existingExternalId} is gone; falling back to a Date lookup`);
    }
    const response = await this.client.dataSources.query({
      data_source_id: dataSourceId,
      filter: { property: "Date", date: { equals: date } },
      result_type: "page",
      page_size: 100,
    });
    const pages = response.results.filter((result) => result.object === "page");
    if (pages.length > 1) {
      throw new Error(`Found ${pages.length} Notion pages for Date ${date}; resolve duplicates before continuing`);
    }
    return pages[0]?.id;
  }

  private async appendBlocks(pageId: string, blocks: BlockObjectRequest[]): Promise<void> {
    for (let index = 0; index < blocks.length; index += BLOCKS_PER_REQUEST) {
      await this.client.blocks.children.append({
        block_id: pageId,
        children: blocks.slice(index, index + BLOCKS_PER_REQUEST),
      });
    }
  }
}
