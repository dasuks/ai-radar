import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppendBlockChildrenParameters,
  CreatePageParameters,
  UpdatePageParameters,
} from "@notionhq/client";
import type { DailyBriefing } from "../src/schemas/briefing.js";
import {
  type NotionClient,
  writeNotionDailyBrief,
} from "../src/writers/notion-writer.js";

const baseBriefing: DailyBriefing = {
  date: "2026-09-12",
  title: "AI Coding Daily Brief",
  summary: ["핵심 요약"],
  topics: [
    {
      id: "verification-loop",
      title: "Verification Loop",
      type: "pattern",
      importance: 5,
      whatChanged: "변경 내용",
      whyItMatters: "중요한 이유",
      howDevelopersUseIt: "사용 방법",
      howToApply: "적용 방법",
      related: ["Independent Review"],
      sources: [{ title: "Source", url: "https://example.com" }],
    },
  ],
};

interface Calls {
  append: AppendBlockChildrenParameters[];
  create: CreatePageParameters[];
  update: UpdatePageParameters[];
}

function fakeClient(
  existingPageId?: string,
  useConfiguredIdAsDataSource = false,
  searchParentId = "database-id",
  schemaUnavailable = false,
): {
  calls: Calls;
  client: NotionClient;
} {
  const calls: Calls = { append: [], create: [], update: [] };
  const client = {
    databases: {
      retrieve: async () => ({
        object: "database",
        id: "database-id",
        ...(useConfiguredIdAsDataSource
          ? {}
          : {
              data_sources: [
                { id: "data-source-id", name: "AI Coding Daily" },
              ],
            }),
      }),
    },
    dataSources: {
      retrieve: async () => ({
        object: "data_source",
        id: "data-source-id",
        properties: schemaUnavailable
          ? {}
          : {
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
        results: existingPageId
          ? [{ object: "page", id: existingPageId }]
          : [],
      }),
    },
    search: async () => ({
      object: "list",
      has_more: false,
      next_cursor: null,
      results: useConfiguredIdAsDataSource
        ? [
            {
              object: "data_source",
              id: "data-source-id",
              parent: { type: "database_id", database_id: searchParentId },
            },
          ]
        : [],
    }),
    pages: {
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

test("새 날짜는 체크박스를 false로 생성하고 긴 본문을 제한에 맞춰 나눈다", async () => {
  const { calls, client } = fakeClient();
  const briefing: DailyBriefing = {
    ...baseBriefing,
    summary: ["가".repeat(2_001), ...Array.from({ length: 100 }, (_, i) => `요약 ${i}`)],
    topics: [],
  };

  const result = await writeNotionDailyBrief(briefing, {
    token: "test-token",
    databaseId: "database-id",
    client,
  });

  assert.equal(result.action, "created");
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0]?.properties?.Read, { checkbox: false });
  assert.deepEqual(calls.create[0]?.properties?.Applied, { checkbox: false });
  assert.deepEqual(calls.append.map((call) => call.children.length), [100, 4]);
  assert.ok(contentLengths(calls.append).every((length) => length <= 2_000));
});

test("같은 날짜는 기존 페이지를 갱신하며 Read와 Applied를 요청에서 제외한다", async () => {
  const { calls, client } = fakeClient("existing-page-id");

  const result = await writeNotionDailyBrief(baseBriefing, {
    token: "test-token",
    databaseId: "database-id",
    client,
  });

  assert.deepEqual(result, { action: "updated", pageId: "existing-page-id" });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0]?.erase_content, true);
  assert.equal("Read" in (calls.update[0]?.properties ?? {}), false);
  assert.equal("Applied" in (calls.update[0]?.properties ?? {}), false);
  assert.ok(calls.append.length > 0);
});

test("설정값이 data source ID인 경우에도 스키마 확인 후 저장한다", async () => {
  const { calls, client } = fakeClient(undefined, true);

  const result = await writeNotionDailyBrief(baseBriefing, {
    token: "test-token",
    databaseId: "data-source-id",
    client,
  });

  assert.equal(result.action, "created");
  assert.deepEqual(calls.create[0]?.parent, {
    type: "data_source_id",
    data_source_id: "data-source-id",
  });
});

test("설정 ID가 일치하지 않아도 스키마가 유일하게 일치하면 저장한다", async () => {
  const { calls, client } = fakeClient(undefined, true, "different-database-id");

  const result = await writeNotionDailyBrief(baseBriefing, {
    token: "test-token",
    databaseId: "view-id",
    client,
  });

  assert.equal(result.action, "created");
  assert.deepEqual(calls.create[0]?.parent, {
    type: "data_source_id",
    data_source_id: "data-source-id",
  });
});

test("유일한 data source의 스키마가 축약 응답이어도 API 쓰기로 검증한다", async () => {
  const { calls, client } = fakeClient(
    undefined,
    true,
    "different-database-id",
    true,
  );

  const result = await writeNotionDailyBrief(baseBriefing, {
    token: "test-token",
    databaseId: "view-id",
    client,
  });

  assert.equal(result.action, "created");
  assert.equal(calls.create.length, 1);
});
