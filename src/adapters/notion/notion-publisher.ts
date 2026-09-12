import { Client, type BlockObjectRequest } from "@notionhq/client";
import type { ChannelId } from "../../domain/artifacts/artifact.js";
import type { PublishOutcome, Publisher, Rendered } from "../../ports/publishing/index.js";
import type { Logger } from "../../ports/system/index.js";
import {
  NOTION_API_VERSION,
  NotionDataSourceResolver,
  appendBlocks,
  dateOf,
  payloadOf,
  type NotionClient,
} from "./data-source.js";

export type { NotionClient } from "./data-source.js";

const REQUIRED_PROPERTIES = {
  Name: "title",
  Date: "date",
  Topics: "multi_select",
  Importance: "number",
  Read: "checkbox",
  Applied: "checkbox",
} as const;

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
  private readonly dataSources: NotionDataSourceResolver;

  constructor(options: NotionPublisherOptions) {
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
    const dataSourceId = await this.dataSources.resolve();
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
    await appendBlocks(this.client, pageId, blocks);
  }
}
