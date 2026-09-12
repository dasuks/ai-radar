import { Client } from "@notionhq/client";
import type { ChannelId } from "../../domain/artifacts/artifact.js";
import type { PublishOutcome, Publisher, Rendered } from "../../ports/publishing/index.js";
import type { Logger } from "../../ports/system/index.js";
import {
  NOTION_API_VERSION,
  NotionDataSourceResolver,
  appendBlocks,
  dateOf,
  payloadOf,
  selectNameOf,
  type NotionClient,
} from "./data-source.js";

/** "AI Radar Reports" DB 의 필수 속성. Read/Applied 는 사용자 소유 필드다. */
const REQUIRED_PROPERTIES = {
  Name: "title",
  Date: "date",
  Section: "select",
  Items: "number",
  Importance: "number",
  Read: "checkbox",
  Applied: "checkbox",
} as const;

const SECTION_PROPERTY = "Section";

export interface NotionReportsPublisherOptions {
  token: string;
  databaseId: string;
  /** 설정된 data source id. 있으면 자동 탐색을 하지 않는다 */
  dataSourceId?: string | undefined;
  /** 설정 ID 와 무관한 data source 로의 스키마 fallback 허용 여부 (R-N1, 기본 false) */
  allowSchemaFallback: boolean;
  client?: NotionClient;
  logger?: Logger;
}

export function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replaceAll("-", "")}`;
}

/**
 * 섹션 상세 리포트 / 전체 목록 전용 Publisher ("AI Radar Reports" DB).
 * Daily 와 같은 사용자 데이터 보호 규칙을 따른다 (INTEGRATIONS_AND_SAFETY.md §1.3):
 * - 갱신 요청에 Read/Applied 를 넣지 않는다 (생성 시에만 false 로 초기화).
 * - upsert 키는 Date + Section 이며, 같은 키의 페이지가 2개 이상이면 중단한다.
 * - 설정 ID 와 무관한 data source 로의 fallback 은 opt-in 일 때만.
 */
export class NotionReportsPublisher implements Publisher {
  readonly channel: ChannelId = "notion";
  private readonly client: NotionClient;
  private readonly logger: Logger | undefined;
  private readonly dataSources: NotionDataSourceResolver;

  constructor(options: NotionReportsPublisherOptions) {
    this.client =
      options.client ??
      new Client({ auth: options.token, notionVersion: NOTION_API_VERSION, logger: () => undefined });
    this.logger = options.logger;
    this.dataSources = new NotionDataSourceResolver({
      databaseId: options.databaseId,
      dataSourceId: options.dataSourceId,
      allowSchemaFallback: options.allowSchemaFallback,
      requiredProperties: REQUIRED_PROPERTIES,
      client: this.client,
      logger: options.logger,
      databaseIdLabel: "NOTION_REPORTS_DATABASE_ID",
      dataSourceIdLabel: "NOTION_REPORTS_DATA_SOURCE_ID",
    });
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
    const section = selectNameOf(payload.properties, SECTION_PROPERTY);
    const dataSourceId = await this.dataSources.resolve();
    const pageId = await this.findPageId(dataSourceId, date, section, input.existingExternalId);

    if (input.dryRun) {
      this.logger?.info(
        pageId ? `dry-run: would update report page ${pageId}` : "dry-run: would create a new report page",
        { date, section, blocks: payload.blocks.length, revision: input.revision },
      );
      return { externalId: pageId ?? null, externalUrl: null, action: "skipped" };
    }

    if (pageId) {
      await this.client.pages.update({ page_id: pageId, properties: payload.properties, erase_content: true });
      await appendBlocks(this.client, pageId, payload.blocks);
      return { externalId: pageId, externalUrl: notionPageUrl(pageId), action: "updated" };
    }

    const page = await this.client.pages.create({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: {
        ...payload.properties,
        Read: { checkbox: false },
        Applied: { checkbox: false },
      },
    });
    await appendBlocks(this.client, page.id, payload.blocks);
    return { externalId: page.id, externalUrl: notionPageUrl(page.id), action: "created" };
  }

  async verify(externalId: string): Promise<boolean> {
    try {
      await this.client.pages.retrieve({ page_id: externalId });
      return true;
    } catch {
      return false;
    }
  }

  private async findPageId(
    dataSourceId: string,
    date: string,
    section: string,
    existingExternalId: string | null,
  ): Promise<string | undefined> {
    if (existingExternalId) {
      if (await this.verify(existingExternalId)) return existingExternalId;
      this.logger?.warn(`recorded Notion page ${existingExternalId} is gone; falling back to a Date+Section lookup`);
    }
    const response = await this.client.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        and: [
          { property: "Date", date: { equals: date } },
          { property: SECTION_PROPERTY, select: { equals: section } },
        ],
      },
      result_type: "page",
      page_size: 100,
    });
    const pages = response.results.filter((result) => result.object === "page");
    if (pages.length > 1) {
      throw new Error(
        `Found ${pages.length} Notion pages for Date ${date} / Section ${section}; resolve duplicates before continuing`,
      );
    }
    return pages[0]?.id;
  }
}
