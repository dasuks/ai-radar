import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishArtifact } from "../src/application/publish/publish-artifact.js";
import { JsonFileArtifactStore } from "../src/adapters/storage/json-files/artifact-store.js";
import { FixedClock } from "../src/adapters/system/clock.js";
import type { DailyBriefBody } from "../src/domain/artifacts/daily-brief.js";
import type { PublishOutcome, Publisher, Rendered, Renderer } from "../src/ports/publishing/index.js";
import type { Artifact, ChannelId } from "../src/domain/artifacts/artifact.js";
import { silentLogger } from "./helpers/memory-vault.js";
import { dailyArtifact } from "./helpers/daily-brief-fixture.js";

const clock = new FixedClock(Date.UTC(2026, 8, 12, 0, 0, 0));

function fakeRenderer(channel: ChannelId): Renderer<DailyBriefBody> {
  return {
    channel,
    render(artifact: Artifact<DailyBriefBody>): Rendered {
      return { channel, hash: `hash-${artifact.revision}`, payload: { revision: artifact.revision }, preview: "" };
    },
  };
}

class FakePublisher implements Publisher {
  calls = 0;
  constructor(
    readonly channel: ChannelId,
    private readonly behaviour: (call: number) => PublishOutcome,
  ) {}

  async publish(): Promise<PublishOutcome> {
    this.calls += 1;
    return this.behaviour(this.calls);
  }
}

async function store(): Promise<JsonFileArtifactStore> {
  return new JsonFileArtifactStore(await mkdtemp(join(tmpdir(), "ai-radar-publish-")));
}

test("같은 revision 이 이미 SUCCEEDED 면 다시 발행하지 않는다", async () => {
  const artifactStore = await store();
  const artifact = dailyArtifact();
  const publisher = new FakePublisher("notion", () => ({
    externalId: "page-1",
    externalUrl: null,
    action: "created",
  }));

  const first = await publishArtifact({
    artifact,
    channel: "notion",
    renderer: fakeRenderer("notion"),
    publisher,
    artifactStore,
    runId: "run_1",
    dryRun: false,
    clock,
    logger: silentLogger(),
  });
  const second = await publishArtifact({
    artifact,
    channel: "notion",
    renderer: fakeRenderer("notion"),
    publisher,
    artifactStore,
    runId: "run_2",
    dryRun: false,
    clock,
    logger: silentLogger(),
  });

  assert.equal(first.status, "SUCCEEDED");
  assert.equal(first.attempt, 1);
  assert.equal(publisher.calls, 1);
  assert.equal(second.status, "SUCCEEDED");
  assert.equal(second.runId, "run_1");
  assert.equal(second.externalId, "page-1");
});

test("채널 실패는 throw 하지 않고 FAILED 기록을 돌려준다", async () => {
  const artifactStore = await store();
  const artifact = dailyArtifact();
  const publisher: Publisher = {
    channel: "notion",
    async publish() {
      throw new Error("notion is down");
    },
  };

  const record = await publishArtifact({
    artifact,
    channel: "notion",
    renderer: fakeRenderer("notion"),
    publisher,
    artifactStore,
    runId: "run_1",
    dryRun: false,
    clock,
    logger: silentLogger(),
  });

  assert.equal(record.status, "FAILED");
  assert.equal(record.error, "notion is down");
  assert.equal(record.attempt, 1);
  assert.equal(await artifactStore.latestPublication(artifact.id, "notion").then((r) => r?.status), "FAILED");
});

test("PRIVATE artifact 는 PRIVATE 을 허용하지 않는 채널로 나가지 않는다", async () => {
  const artifactStore = await store();
  const artifact = dailyArtifact();
  const publisher = new FakePublisher("instagram", () => ({
    externalId: "post-1",
    externalUrl: null,
    action: "created",
  }));

  const record = await publishArtifact({
    artifact,
    channel: "instagram",
    renderer: fakeRenderer("instagram"),
    publisher,
    artifactStore,
    runId: "run_1",
    dryRun: false,
    clock,
    logger: silentLogger(),
  });

  assert.equal(record.status, "FAILED");
  assert.match(record.error ?? "", /does not accept PRIVATE artifacts/);
  assert.equal(publisher.calls, 0);
});
