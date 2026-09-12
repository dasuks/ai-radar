import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppendBlockChildrenParameters,
  BlockObjectRequest,
  CreatePageParameters,
  UpdatePageParameters,
} from "@notionhq/client";
import { NotionReportsPublisher, notionPageUrl } from "../src/adapters/notion/notion-reports-publisher.js";
import type { NotionClient } from "../src/adapters/notion/data-source.js";
import type { Rendered } from "../src/ports/publishing/index.js";

interface Calls {
  append: AppendBlockChildrenParameters[];
  create: CreatePageParameters[];
  update: UpdatePageParameters[];
  query: Array<Record<string, unknown>>;
}

interface FakeOptions {
  existingPageIds?: string[];
  /** databases.retrieve 가 data_sources 를 주지 않는 경우 (search fallback 경로) */
  emptyDatabaseSources?: boolean;
  searchParentId?: string;
  /** 스키마에서 뺄 속성 이름 */
  missingProperty?: string;
  missingPage?: string;
}

function fakeClient(options: FakeOptions = {}): { calls: Calls; client: NotionClient } {
  const calls: Calls = { append: [], create: [], update: [], query: [] };
  const properties: Record<string, { type: string }> = {
    Name: { type: "title" },
    Date: { type: "date" },
    Section: { type: "select" },
    Items: { type: "number" },
    Importance: { type: "number" },
    Read: { type: "checkbox" },
    Applied: { type: "checkbox" },
  };
  if (options.missingProperty) delete properties[options.missingProperty];

  const client = {
    databases: {
      retrieve: async () => ({
        object: "database",
        id: "reports-database-id",
        ...(options.emptyDatabaseSources
          ? {}
          : { data_sources: [{ id: "reports-data-source-id", name: "AI Radar Reports" }] }),
      }),
    },
    dataSources: {
      retrieve: async () => ({ object: "data_source", id: "reports-data-source-id", properties }),
      query: async (parameters: Record<string, unknown>) => {
        calls.query.push(parameters);
        return {
          object: "list",
          results: (options.existingPageIds ?? []).map((id) => ({ object: "page", id })),
        };
      },
    },
    search: async () => ({
      object: "list",
      has_more: false,
      next_cursor: null,
      results: options.emptyDatabaseSources
        ? [
            {
              object: "data_source",
              id: "reports-data-source-id",
              parent: { type: "database_id", database_id: options.searchParentId ?? "reports-database-id" },
            },
          ]
        : [],
    }),
    pages: {
      retrieve: async ({ page_id }: { page_id: string }) => {
        if (page_id === options.missingPage) throw new Error("not found");
        return { object: "page", id: page_id };
      },
      create: async (parameters: CreatePageParameters) => {
        calls.create.push(parameters);
        return { object: "page", id: "11111111-2222-3333-4444-555555555555" };
      },
      update: async (parameters: UpdatePageParameters) => {
        calls.update.push(parameters);
        return { object: "page", id: parameters.page_id };
      },
    },
    blocks: {
      children: {
        append: async (parameters: AppendBlockChildrenParameters) => {
          calls.append.push(parameters);
          return { object: "list", results: [] };
        },
      },
    },
  } as unknown as NotionClient;

  return { calls, client };
}

function paragraph(content: string): BlockObjectRequest {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } };
}

function rendered(overrides: { section?: string; blockCount?: number } = {}): Rendered {
  const blockCount = overrides.blockCount ?? 3;
  return {
    channel: "notion",
    hash: "rendered-hash",
    payload: {
      kind: "section-report",
      properties: {
        Name: { title: [{ type: "text", text: { content: "2026-09-12 · AI Coding 상세" } }] },
        Date: { date: { start: "2026-09-12" } },
        Section: { select: { name: overrides.section ?? "AI Coding" } },
        Items: { number: 1 },
        Importance: { number: 4 },
      },
      blocks: Array.from({ length: blockCount }, (_, index) => paragraph(`문단 ${index}`)),
    },
    preview: "preview",
  };
}

function publisher(client: NotionClient, allowSchemaFallback = false, databaseId = "reports-database-id") {
  return new NotionReportsPublisher({
    token: "test-token",
    databaseId,
    allowSchemaFallback,
    client,
  });
}

test("새 Date+Section 은 Read/Applied 를 false 로 생성하고 블록을 100개씩 붙인다", async () => {
  const { calls, client } = fakeClient();

  const outcome = await publisher(client).publish({
    artifactId: "art_section_report_2026-09-12:AI_CODING",
    revision: 1,
    rendered: rendered({ blockCount: 250 }),
    existingExternalId: null,
    dryRun: false,
  });

  assert.equal(outcome.action, "created");
  assert.equal(outcome.externalId, "11111111-2222-3333-4444-555555555555");
  assert.equal(outcome.externalUrl, "https://www.notion.so/11111111222233334444555555555555");
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0]?.properties?.Read, { checkbox: false });
  assert.deepEqual(calls.create[0]?.properties?.Applied, { checkbox: false });
  assert.deepEqual(calls.create[0]?.parent, {
    type: "data_source_id",
    data_source_id: "reports-data-source-id",
  });
  assert.equal(calls.append.length, 3);
  assert.deepEqual(calls.append.map((call) => call.children.length), [100, 100, 50]);
});

test("upsert 키는 Date equals AND Section equals 이다", async () => {
  const { calls, client } = fakeClient();

  await publisher(client).publish({
    artifactId: "a",
    revision: 1,
    rendered: rendered({ section: "전체 목록" }),
    existingExternalId: null,
    dryRun: false,
  });

  assert.equal(calls.query.length, 1);
  assert.deepEqual(calls.query[0]?.filter, {
    and: [
      { property: "Date", date: { equals: "2026-09-12" } },
      { property: "Section", select: { equals: "전체 목록" } },
    ],
  });
});

test("같은 Date+Section 은 갱신하며 Read/Applied 를 요청에서 빼고 본문을 지운다", async () => {
  const { calls, client } = fakeClient({ existingPageIds: ["existing-page-id"] });

  const outcome = await publisher(client).publish({
    artifactId: "a",
    revision: 2,
    rendered: rendered(),
    existingExternalId: null,
    dryRun: false,
  });

  assert.deepEqual(outcome, {
    externalId: "existing-page-id",
    externalUrl: notionPageUrl("existing-page-id"),
    action: "updated",
  });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0]?.erase_content, true);
  assert.equal("Read" in (calls.update[0]?.properties ?? {}), false);
  assert.equal("Applied" in (calls.update[0]?.properties ?? {}), false);
  assert.ok(calls.append.length > 0);
});

test("existingExternalId 가 있으면 조회 없이 그 페이지를 갱신한다", async () => {
  const { calls, client } = fakeClient();

  const outcome = await publisher(client).publish({
    artifactId: "a",
    revision: 1,
    rendered: rendered(),
    existingExternalId: "recorded-page-id",
    dryRun: false,
  });

  assert.equal(outcome.action, "updated");
  assert.equal(outcome.externalId, "recorded-page-id");
  assert.equal(calls.query.length, 0);
  assert.equal(calls.update[0]?.page_id, "recorded-page-id");
});

test("기록된 페이지가 사라졌으면 Date+Section 조회로 되돌아간다", async () => {
  const { calls, client } = fakeClient({ missingPage: "gone-page-id" });

  const outcome = await publisher(client).publish({
    artifactId: "a",
    revision: 1,
    rendered: rendered(),
    existingExternalId: "gone-page-id",
    dryRun: false,
  });

  assert.equal(outcome.action, "created");
  assert.equal(calls.query.length, 1);
});

test("같은 Date+Section 페이지가 2개 이상이면 중단한다", async () => {
  const { calls, client } = fakeClient({ existingPageIds: ["a-page", "b-page"] });

  await assert.rejects(
    publisher(client).publish({
      artifactId: "a",
      revision: 1,
      rendered: rendered(),
      existingExternalId: null,
      dryRun: false,
    }),
    /Found 2 Notion pages for Date 2026-09-12 \/ Section AI Coding/,
  );
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
});

test("dry-run 은 쓰지 않고 skipped 를 돌려준다", async () => {
  const { calls, client } = fakeClient({ existingPageIds: ["existing-page-id"] });

  const outcome = await publisher(client).publish({
    artifactId: "a",
    revision: 1,
    rendered: rendered(),
    existingExternalId: null,
    dryRun: true,
  });

  assert.deepEqual(outcome, { externalId: "existing-page-id", externalUrl: null, action: "skipped" });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.append.length, 0);
});

test("필수 속성이 없는 DB 는 거부한다", async () => {
  const { calls, client } = fakeClient({ missingProperty: "Section" });

  await assert.rejects(
    publisher(client).publish({
      artifactId: "a",
      revision: 1,
      rendered: rendered(),
      existingExternalId: null,
      dryRun: false,
    }),
    /schema mismatch: missing property 'Section'/,
  );
  assert.equal(calls.create.length, 0);
});

test("설정 ID 와 무관한 data source 로의 스키마 fallback 을 기본값에서는 거부한다", async () => {
  const { calls, client } = fakeClient({ emptyDatabaseSources: true, searchParentId: "different-database-id" });

  await assert.rejects(
    publisher(client, false, "view-id").publish({
      artifactId: "a",
      revision: 1,
      rendered: rendered(),
      existingExternalId: null,
      dryRun: false,
    }),
    /NOTION_REPORTS_DATABASE_ID[\s\S]*NOTION_ALLOW_SCHEMA_FALLBACK/,
  );
  assert.equal(calls.create.length, 0);
});

test("NOTION_ALLOW_SCHEMA_FALLBACK 이 켜지면 스키마가 유일하게 일치하는 data source 를 쓴다", async () => {
  const { calls, client } = fakeClient({ emptyDatabaseSources: true, searchParentId: "different-database-id" });

  const outcome = await publisher(client, true, "view-id").publish({
    artifactId: "a",
    revision: 1,
    rendered: rendered(),
    existingExternalId: null,
    dryRun: false,
  });

  assert.equal(outcome.action, "created");
  assert.deepEqual(calls.create[0]?.parent, {
    type: "data_source_id",
    data_source_id: "reports-data-source-id",
  });
});

test("설정된 data source ID 를 그대로 쓴다", async () => {
  const { calls, client } = fakeClient();
  const instance = new NotionReportsPublisher({
    token: "test-token",
    databaseId: "reports-database-id",
    dataSourceId: "configured-reports-data-source-id",
    allowSchemaFallback: false,
    client,
  });

  await instance.publish({
    artifactId: "a",
    revision: 1,
    rendered: rendered(),
    existingExternalId: null,
    dryRun: false,
  });

  assert.deepEqual(calls.create[0]?.parent, {
    type: "data_source_id",
    data_source_id: "configured-reports-data-source-id",
  });
});

test("notionPageUrl 은 대시를 뺀 page id 로 주소를 만든다", () => {
  assert.equal(notionPageUrl("abc-def"), "https://www.notion.so/abcdef");
});
