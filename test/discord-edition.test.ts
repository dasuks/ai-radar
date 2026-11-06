import test from "node:test";
import assert from "node:assert/strict";
import { DISCORD_SECTORS, parseDiscordEdition, type DiscordEditionBody, type DiscordDeliveryPayload, type DiscordPost, type DiscordPostV2 } from "../src/domain/artifacts/discord-edition.js";
import { BuildDiscordEdition, discordEditorialCacheHash } from "../src/application/discord/build-discord-edition.js";
import { DiscordEditionRenderer } from "../src/adapters/rendering/discord/edition-renderer.js";
import { FakeLlmProvider } from "../src/adapters/llm/fake/fake-llm-provider.js";
import { createMemoryStores } from "../src/adapters/storage/memory/index.js";
import { makeClaim, makeDocument, makeEvidence } from "./helpers/store-conformance.js";
import { briefItem, dailyArtifact, dailyBriefBody } from "./helpers/daily-brief-fixture.js";

function post(overrides: Partial<DiscordPost> = {}): DiscordPost {
  return { id: briefItem().id, sector: "coding", title: "검증 루프", summary: "독립 검토 과정을 소개한다.",
    detail: "검토 단계를 분리하는 워크플로다.", example: "간단한 앱을 만든다고 가정하면 테스트를 별도 실행할 수 있다.",
    caveat: "모든 프로젝트에서 성능이 확인된 것은 아니다.", evidenceLabel: "원문 설명", links: [{ label: "원문", url: "https://example.com" }], ...overrides };
}
function edition(posts = [post()]): DiscordEditionBody { return { bodySchemaVersion: 1, date: "2026-09-12", posts }; }
function postV2(overrides: Partial<DiscordPostV2> = {}): DiscordPostV2 {
  return { id: briefItem().id, sector: "coding", title: "검증 단계를 분리", summary: "코드 작성 뒤 독립 검토를 실행한다.",
    detail: "작성자와 다른 검토 과정이 테스트에서 빠진 오류 상황을 찾는다.", example: null, caveat: null,
    links: [{ label: "원문", url: "https://example.com" }], ...overrides };
}
function editionV2(posts = [postV2()]): DiscordEditionBody { return { bodySchemaVersion: 2, date: "2026-09-12", posts }; }
function render(body: DiscordEditionBody) { return new DiscordEditionRenderer().render({ ...dailyArtifact(), type: "DISCORD_EDITION", body }); }

test("Discord routes every sector and preserves original resource URLs with hypothetical examples", () => {
  const body = edition(DISCORD_SECTORS.map((sector) => post({ id: sector, sector, links: [{ label: "원문", url: "https://example.com/path?q=(a)" }, { label: "실습", url: "https://github.com/example/repo" }] })));
  const rendered = render(body);
  const payload = rendered.payload as DiscordDeliveryPayload;
  assert.deepEqual(payload.posts.map((p) => p.channel), DISCORD_SECTORS);
  for (const p of payload.posts) {
    assert.ok(p.content.length <= 2000);
    assert.match(p.content, /\*\*활용 예시 \(가상 시나리오\)\*\* 간단한 앱을 만든다고 가정하면/);
    assert.ok(p.content.includes("https://example.com/path?q=(a)"));
    assert.ok(p.content.includes("https://github.com/example/repo"));
    assert.doesNotMatch(p.content, /내 환경|내 프로젝트/);
  }
  assert.equal(render(body).hash, rendered.hash);
});

test("v2 renders plain prose and omits empty example and caveat, while v1 stays readable", () => {
  const text = (render(editionV2()).payload as DiscordDeliveryPayload).posts[0]!.content;
  assert.match(text, /검증 단계를 분리/);
  assert.doesNotMatch(text, /활용 예시|유의할 점|근거/);
  assert.match(text, /\[원문\]\(<https:\/\/example.com>\)/);
  assert.match((render(edition()).payload as DiscordDeliveryPayload).posts[0]!.content, /원문 설명/);
  const withExample = (render(editionV2([postV2({ example: "예를 들어 긴 문서를 읽는다면 빠진 부분을 다시 확인할 수 있어요." })])).payload as DiscordDeliveryPayload).posts[0]!.content;
  assert.match(withExample, /\*\*활용 예시\*\* 예를 들어 긴 문서를 읽는다면/);
  assert.doesNotMatch(withExample, /가상 시나리오|유의할 점/);
  assert.throws(() => parseDiscordEdition(editionV2([postV2({ example: "" })])));
});

test("manual parser rejects malformed contracts, duplicates, unsafe links and long prose", () => {
  for (const url of ["http://example.com", "https://localhost", "https://127.0.0.1", "https://2130706433", "https://[::1]", "https://10.0.0.1", "https://service.internal", "https://user:pass@example.com", "https://127.0.0.1.nip.io", "https://host.local."]) {
    assert.throws(() => parseDiscordEdition(edition([post({ links: [{ label: "원문", url }] })])), url);
  }
  for (const value of [null, { ...edition(), date: "2026-02-30" }, { ...edition(), extra: true }, edition([post(), post()]), edition([post({ summary: "가".repeat(181) })]), edition([post({ links: [] })]), edition([post({ detail: "https://invented.example.com" })])]) {
    assert.throws(() => parseDiscordEdition(value));
  }
});

test("renderer rejects oversize messages without truncating links", () => {
  assert.throws(() => render(edition([post({ title: "가".repeat(100), summary: "가".repeat(180), detail: "가".repeat(500), example: "가".repeat(350), caveat: "가".repeat(300), evidenceLabel: "가".repeat(100), links: [{ label: "원문", url: `https://example.com/${"a".repeat(400)}` }] })])), /2000/);
});

test("curation can select a subset in one call and excludes personal input fields", async () => {
  const llm = new FakeLlmProvider({ WRITE_DISCORD: () => editionV2() });
  const brief = dailyBriefBody({ sections: [{ kind: "AI_CODING", report: null, items: [briefItem({ howToApply: "PRIVATE PROJECT SECRET" }), briefItem({ id: "other" })] }] });
  const result = await new BuildDiscordEdition({ llm, model: "test" }).execute(brief);
  assert.equal(result.posts.length, 1);
  assert.equal(llm.callCount, 1);
  assert.doesNotMatch(JSON.stringify(llm.calls[0]!.req.untrusted), /PRIVATE PROJECT SECRET/);
});

test("curation rejects unknown IDs, invented or omitted resource links, and malformed output", async () => {
  const item = briefItem();
  item.sourceRefs.push({ ...item.sourceRefs[0]!, documentId: "resource", url: "https://github.com/example/repo" });
  const brief = dailyBriefBody({ sections: [{ kind: "AI_CODING", report: null, items: [item] }] });
  for (const output of [null, { posts: [] }, editionV2([postV2({ id: "unknown" })]), edition(), editionV2([postV2({ links: [{ label: "새 출처", url: "https://invented.example.com" }] })])]) {
    const llm = new FakeLlmProvider({ WRITE_DISCORD: () => output });
    await assert.rejects(() => new BuildDiscordEdition({ llm, model: "test" }).execute(brief));
    assert.equal(llm.callCount, 1);
  }
  const llm = new FakeLlmProvider({ WRITE_DISCORD: () => editionV2([postV2({ links: item.sourceRefs.map((ref) => ({ label: ref.title, url: ref.url })) })]) });
  assert.equal((await new BuildDiscordEdition({ llm, model: "test" }).execute(brief)).posts[0]!.links.length, 2);
});

test("no-source and empty selection produce no fallback spam", async () => {
  const llm = new FakeLlmProvider({ WRITE_DISCORD: () => editionV2([]) });
  const builder = new BuildDiscordEdition({ llm, model: "test" });
  assert.deepEqual((await builder.execute(dailyBriefBody())).posts, []);
  assert.equal(llm.callCount, 1);
  const brief = dailyBriefBody({ sections: [{ kind: "AI_CODING", report: null, items: [briefItem({ sourceRefs: [] })] }] });
  assert.deepEqual((await builder.execute(brief)).posts, []);
  assert.equal(llm.callCount, 1);
});

test("stored public-source document, qualified claim and known resource enrich one candidate", async () => {
  const stores = createMemoryStores();
  const doc = makeDocument({ sourceId: "release-feed", canonicalUrl: "https://example.com",
    urls: ["https://example.com", "https://github.com/example/repo"], content: "Specific mechanism from original release.",
    publishedAt: "2026-09-10T00:00:00.000Z" });
  await stores.documents.upsert(doc);
  const evidence = makeEvidence({ documentId: doc.id, locator: { kind: "excerpt", start: 0, end: 8, text: "Mechanism" } });
  await stores.claims.putEvidence([evidence]);
  const claim = makeClaim({ evidenceIds: [evidence.id], type: "OFFICIAL_CLAIM", statement: "Official claim with qualification", visibility: "PRIVATE" });
  await stores.claims.putClaims([claim]);
  const item = briefItem({ sourceRefs: [{ ...briefItem().sourceRefs[0]!, documentId: doc.id, sourceId: doc.sourceId }], claimIds: [claim.id], howToApply: "PRIVATE NOTE" });
  const brief = dailyBriefBody({ sections: [{ kind: "AI_CODING", report: null, items: [item] }] });
  const llm = new FakeLlmProvider({ WRITE_DISCORD: () => editionV2([postV2({ links: [
    { label: "공식 변경 기록", url: "https://example.com" }, { label: "코드", url: "https://github.com/example/repo" },
  ] })]) });
  const builder = new BuildDiscordEdition({ llm, model: "test", stores, allowedSourceIds: ["release-feed"] });
  const before = await builder.prepare(brief);
  assert.equal(before[0]?.claims[0]?.type, "OFFICIAL_CLAIM");
  assert.equal(before[0]?.claims[0]?.evidence[0], "Mechanism");
  assert.equal(before[0]?.documents[0]?.content, doc.content);
  assert.doesNotMatch(JSON.stringify(before), /PRIVATE NOTE/);
  assert.equal((await builder.execute(brief, undefined, before)).posts.length, 1);
  assert.match(JSON.stringify(llm.calls[0]!.req.untrusted), /Specific mechanism/);
  assert.notEqual(discordEditorialCacheHash("brief", "test", before), discordEditorialCacheHash("brief", "test", [{ ...before[0]!, documents: [{ ...before[0]!.documents[0]!, content: "Updated mechanism" }] }]));
});

test("unmatched stored document is not exposed, extra URLs are rejected, and >3 source URLs remain candidates", async () => {
  const stores = createMemoryStores();
  const doc = makeDocument({ sourceId: "private-feed", canonicalUrl: "https://example.com", urls: ["https://example.com", "https://private.example.com"], content: "PRIVATE STORED SECRET" });
  await stores.documents.upsert(doc);
  const item = briefItem({ sourceRefs: [{ ...briefItem().sourceRefs[0]!, documentId: doc.id, sourceId: "release-feed" }] });
  const brief = dailyBriefBody({ sections: [{ kind: "AI_CODING", report: null, items: [item] }] });
  const llm = new FakeLlmProvider({ WRITE_DISCORD: () => editionV2([postV2({ links: [{ label: "원문", url: "https://example.com" }, { label: "잘못된 자료", url: "https://private.example.com" }] })]) });
  const builder = new BuildDiscordEdition({ llm, model: "test", stores, allowedSourceIds: ["release-feed"] });
  assert.equal((await builder.prepare(brief))[0]?.documents.length, 0);
  await assert.rejects(() => builder.execute(brief));
  assert.doesNotMatch(JSON.stringify(llm.calls[0]!.req.untrusted), /PRIVATE STORED SECRET/);
  const refs = ["https://example.com/1", "https://example.com/2", "https://example.com/3", "https://example.com/4"].map((url, index) => ({ ...item.sourceRefs[0]!, documentId: `doc-${index}`, url }));
  const many = dailyBriefBody({ sections: [{ kind: "AI_CODING", report: null, items: [briefItem({ sourceRefs: refs })] }] });
  const manyBuilder = new BuildDiscordEdition({ llm: new FakeLlmProvider({ WRITE_DISCORD: () => editionV2([postV2({ links: refs.map((ref) => ({ label: "원문", url: ref.url })) })]) }), model: "test" });
  assert.equal((await manyBuilder.execute(many)).posts[0]?.links.length, 4);
});
