import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppendBlockChildrenParameters,
  CreatePageParameters,
  UpdatePageParameters,
} from "@notionhq/client";
import { NotionPublisher, type NotionClient } from "../src/adapters/notion/notion-publisher.js";
import { NotionBlocksRenderer } from "../src/adapters/rendering/notion-blocks/daily-renderer.js";
import type { DailyBriefBody } from "../src/domain/artifacts/daily-brief.js";
import { dailyArtifact, dailyBriefBody } from "./helpers/daily-brief-fixture.js";

interface Calls {
  append: AppendBlockChildrenParameters[];
  create: CreatePageParameters[];
  update: UpdatePageParameters[];
}

interface FakeOptions {
  existingPageId?: string;
  /** databases.retrieve 가 data_sources 를 주지 않는 경우 (search fallback 경로) */
  emptyDatabaseSources?: boolean;
  searchParentId?: string;
}

function fakeClient(options: FakeOptions = {}): { calls: Calls; client: NotionClient } {
  const calls: Calls = { append: [], create: [], update: [] };
  const client = {
    databases: {
      retrieve: async () => ({
        object: "database",
        id: "database-id",
        ...(options.emptyDatabaseSources ? {} : { data_sources: [{ id: "data-source-id", name: "AI Coding Daily" }] }),
      }),
    },
    dataSources: {
      retrieve: async () => ({
        object: "data_source",
        id: "data-source-id",
        properties: {
          Name: { type: "title" },
          Date: { type: "date" },
          Topics: { type: "multi_select" },
          Importance: { type: "number" },
          Read: { type: "checkbox" },
          Applied: { type: "checkbox" },
        },
      }),
      query: async () => ({
        object: "list",
        results: options.existingPageId ? [{ object: "page", id: options.existingPageId }] : [],
      }),
    },
    search: async () => ({
      object: "list",
      has_more: false,
      next_cursor: null,
      results: options.emptyDatabaseSources
        ? [
            {
              object: "data_source",
              id: "data-source-id",
              parent: { type: "database_id", database_id: options.searchParentId ?? "database-id" },
            },
          ]
        : [],
    }),
    pages: {
      retrieve: async ({ page_id }: { page_id: string }) => ({ object: "page", id: page_id }),
      create: async (parameters: CreatePageParameters) => {
        calls.create.push(parameters);
        return { object: "page", id: "new-page-id" };
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

function contentLengths(value: unknown): number[] {
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap(contentLengths);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.content === "string" ? [record.content.length] : [];
  return own.concat(Object.values(record).flatMap(contentLengths));
}

function render(body: DailyBriefBody, revision = 1) {
  const artifact = dailyArtifact(body, { revision });
  return { artifact, rendered: new NotionBlocksRenderer().render(artifact) };
}

test("새 날짜는 체크박스를 false 로 생성하고 블록을 100개씩, 본문을 2000자 이하로 나눈다", async () => {
  const { calls, client } = fakeClient();
  const body = dailyBriefBody({
    oneMinuteSummary: ["가".repeat(2_001), ...Array.from({ length: 120 }, (_, index) => `요약 ${index}`)],
    sections: [],
    learnOneThing: null,
    applyCandidates: [],
    sources: [],
  });
  const { artifact, rendered } = render(body);
  const publisher = new NotionPublisher({
    token: "test-token",
    databaseId: "database-id",
    allowSchemaFallback: false,
    client,
  });

  const outcome = await publisher.publish({
    artifactId: artifact.id,
    revision: artifact.revision,
    rendered,
    existingExternalId: null,
    dryRun: false,
  });

  assert.equal(outcome.action, "created");
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0]?.properties?.Read, { checkbox: false });
  assert.deepEqual(calls.create[0]?.properties?.Applied, { checkbox: false });
  assert.ok(calls.append.length >= 2);
  assert.ok(calls.append.every((call) => call.children.length <= 100));
  assert.equal(calls.append[0]?.children.length, 100);
  assert.ok(contentLengths(calls.append).every((length) => length <= 2_000));

  const firstBlock = calls.append[0]?.children[0] as { type?: string; callout?: unknown } | undefined;
  assert.equal(firstBlock?.type, "callout");
  assert.match(JSON.stringify(firstBlock), /ai-radar:revision:1/);
});

test("같은 날짜는 기존 페이지를 갱신하며 Read/Applied 를 요청에서 제외하고 본문을 교체한다", async () => {
  const { calls, client } = fakeClient({ existingPageId: "existing-page-id" });
  const { artifact, rendered } = render(dailyBriefBody());
  const publisher = new NotionPublisher({
    token: "test-token",
    databaseId: "database-id",
    allowSchemaFallback: false,
    client,
  });

  const outcome = await publisher.publish({
    artifactId: artifact.id,
    revision: artifact.revision,
    rendered,
    existingExternalId: null,
    dryRun: false,
  });

  assert.deepEqual(outcome, { externalId: "existing-page-id", externalUrl: null, action: "updated" });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0]?.erase_content, true);
  assert.equal("Read" in (calls.update[0]?.properties ?? {}), false);
  assert.equal("Applied" in (calls.update[0]?.properties ?? {}), false);
  assert.ok(calls.append.length > 0);
});

test("설정된 data source ID 를 그대로 쓴다", async () => {
  const { calls, client } = fakeClient();
  const { artifact, rendered } = render(dailyBriefBody());
  const publisher = new NotionPublisher({
    token: "test-token",
    databaseId: "database-id",
    dataSourceId: "configured-data-source-id",
    allowSchemaFallback: false,
    client,
  });

  await publisher.publish({
    artifactId: artifact.id,
    revision: artifact.revision,
    rendered,
    existingExternalId: null,
    dryRun: false,
  });

  assert.deepEqual(calls.create[0]?.parent, {
    type: "data_source_id",
    data_source_id: "configured-data-source-id",
  });
});

test("설정 ID 와 무관한 data source 로의 스키마 fallback 을 기본값에서는 거부한다", async () => {
  const { calls, client } = fakeClient({ emptyDatabaseSources: true, searchParentId: "different-database-id" });
  const { artifact, rendered } = render(dailyBriefBody());
  const publisher = new NotionPublisher({
    token: "test-token",
    databaseId: "view-id",
    allowSchemaFallback: false,
    client,
  });

  await assert.rejects(
    publisher.publish({
      artifactId: artifact.id,
      revision: artifact.revision,
      rendered,
      existingExternalId: null,
      dryRun: false,
    }),
    /NOTION_ALLOW_SCHEMA_FALLBACK/,
  );
  assert.equal(calls.create.length, 0);
});

test("NOTION_ALLOW_SCHEMA_FALLBACK 이 켜지면 스키마가 유일하게 일치하는 data source 를 쓴다", async () => {
  const { calls, client } = fakeClient({ emptyDatabaseSources: true, searchParentId: "different-database-id" });
  const { artifact, rendered } = render(dailyBriefBody());
  const publisher = new NotionPublisher({
    token: "test-token",
    databaseId: "view-id",
    allowSchemaFallback: true,
    client,
  });

  const outcome = await publisher.publish({
    artifactId: artifact.id,
    revision: artifact.revision,
    rendered,
    existingExternalId: null,
    dryRun: false,
  });

  assert.equal(outcome.action, "created");
  assert.deepEqual(calls.create[0]?.parent, {
    type: "data_source_id",
    data_source_id: "data-source-id",
  });
});
