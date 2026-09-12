/**
 * Notion data source 해석 + 스키마 검사 공용 모듈.
 * Daily DB(NotionPublisher) 와 Reports DB(NotionReportsPublisher) 가 같은 규칙을 쓴다
 * (INTEGRATIONS_AND_SAFETY.md §1.3 item 5, R-N1: 설정 ID 와 무관한 DB 로의 fallback 은 opt-in).
 */
import type { BlockObjectRequest, Client, CreatePageParameters } from "@notionhq/client";
import { isRecord } from "../../domain/shared/validation.js";
import type { Rendered } from "../../ports/publishing/index.js";
import type { Logger } from "../../ports/system/index.js";

export const NOTION_API_VERSION = "2026-03-11";
export const BLOCKS_PER_REQUEST = 100;
export const SCHEMA_UNAVAILABLE = "data source schema is unavailable";

export type NotionClient = Pick<Client, "blocks" | "databases" | "dataSources" | "pages" | "search">;

export type NotionPageProperties = NonNullable<CreatePageParameters["properties"]>;

/** Renderer payload 의 공통 형태. adapter 간 import 금지(ARCH-06)로 rendering 쪽과 따로 선언한다. */
export interface NotionRenderedPayload {
  properties: NotionPageProperties;
  blocks: BlockObjectRequest[];
}

/** 필수 속성 이름 → Notion property type */
export type RequiredProperties = Readonly<Record<string, string>>;

export function normalizeId(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

export function schemaIssues(dataSource: unknown, required: RequiredProperties): string[] {
  if (!isRecord(dataSource)) return [SCHEMA_UNAVAILABLE];
  const properties = dataSource.properties;
  if (!isRecord(properties) || Object.keys(properties).length === 0) return [SCHEMA_UNAVAILABLE];
  return Object.entries(required).flatMap(([name, expectedType]) => {
    const property = properties[name];
    if (!isRecord(property)) return [`missing property '${name}'`];
    return property.type === expectedType ? [] : [`property '${name}' must be ${expectedType}, got ${String(property.type)}`];
  });
}

export function payloadOf(rendered: Rendered): NotionRenderedPayload {
  const payload = rendered.payload;
  if (!isRecord(payload) || !isRecord(payload.properties) || !Array.isArray(payload.blocks)) {
    throw new Error("Notion publisher received a payload that is not { properties, blocks }");
  }
  return payload as unknown as NotionRenderedPayload;
}

/** Date 속성에서 upsert 키로 쓸 날짜를 꺼낸다. */
export function dateOf(properties: NotionPageProperties): string {
  const property = (properties as Record<string, unknown>).Date;
  if (isRecord(property) && isRecord(property.date) && typeof property.date.start === "string") {
    return property.date.start;
  }
  throw new Error("Notion payload is missing the Date property");
}

/** Section select 값 (Reports DB 의 upsert 보조 키). */
export function selectNameOf(properties: NotionPageProperties, name: string): string {
  const property = (properties as Record<string, unknown>)[name];
  if (isRecord(property) && isRecord(property.select) && typeof property.select.name === "string") {
    return property.select.name;
  }
  throw new Error(`Notion payload is missing the ${name} property`);
}

export async function appendBlocks(
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

export interface DataSourceResolverOptions {
  databaseId: string;
  /** 설정된 data source id. 있으면 자동 탐색을 하지 않는다 */
  dataSourceId?: string | undefined;
  /** 설정 ID 와 무관한 data source 로의 스키마 fallback 허용 여부 (R-N1, 기본 false) */
  allowSchemaFallback: boolean;
  requiredProperties: RequiredProperties;
  client: NotionClient;
  logger?: Logger | undefined;
  /** 오류 메시지에 쓸 설정 이름 (기본: Daily DB 의 환경변수 이름) */
  databaseIdLabel?: string | undefined;
  dataSourceIdLabel?: string | undefined;
}

/** 설정 ID → data source id 해석. 한 번 해석하면 캐시한다. */
export class NotionDataSourceResolver {
  private resolved: string | null = null;
  private readonly databaseIdLabel: string;
  private readonly dataSourceIdLabel: string;

  constructor(private readonly options: DataSourceResolverOptions) {
    this.databaseIdLabel = options.databaseIdLabel ?? "NOTION_DATABASE_ID";
    this.dataSourceIdLabel = options.dataSourceIdLabel ?? "NOTION_DATA_SOURCE_ID";
  }

  async resolve(): Promise<string> {
    if (this.resolved) return this.resolved;
    const configured = this.options.dataSourceId?.trim();
    if (configured) {
      this.resolved = configured;
      return configured;
    }
    const discovered = await this.discover();
    this.resolved = discovered;
    return discovered;
  }

  private async discover(): Promise<string> {
    const { client, databaseId, logger } = this.options;
    let references: Array<{ id: string }> = [];
    try {
      const database = await client.databases.retrieve({ database_id: databaseId });
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
        const response = await client.search({
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
            `The configured ${this.databaseIdLabel} could not be resolved to an accessible data source. ` +
              "Refusing to fall back to a schema-matching data source in another database; " +
              `set ${this.dataSourceIdLabel}, or set NOTION_ALLOW_SCHEMA_FALLBACK=true to opt in.`,
          );
        }
        references = discovered;
        usedFallback = true;
      }
    }

    if (references.length === 0) {
      throw new Error(`The configured ${this.databaseIdLabel} could not be resolved to an accessible data source`);
    }

    const matches: string[] = [];
    const failures: string[] = [];
    for (const reference of references) {
      const dataSource = await client.dataSources.retrieve({ data_source_id: reference.id });
      const issues = schemaIssues(dataSource, this.options.requiredProperties);
      if (issues.length === 0) matches.push(reference.id);
      else failures.push(issues.join(", "));
    }

    if (matches.length === 1) {
      if (usedFallback) {
        logger?.warn(
          "using a schema-matching data source that does not match the configured id (NOTION_ALLOW_SCHEMA_FALLBACK)",
        );
      }
      return matches[0]!;
    }
    if (matches.length > 1) {
      throw new Error("Multiple data sources match the required schema; keep one matching data source in the database");
    }
    if (references.length === 1 && failures[0] === SCHEMA_UNAVAILABLE) return references[0]!.id;
    throw new Error(`Notion database schema mismatch: ${failures.join("; ")}`);
  }
}
