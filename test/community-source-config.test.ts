import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/runtime/config/app-config.js";

test("source configuration reuses feeds and keeps Threads missing authorization visible", () => {
  const root = mkdtempSync(join(tmpdir(), "radar-source-config-"));
  try {
    mkdirSync(join(root, "config"));
    const write = (threads: unknown) => writeFileSync(join(root, "config/sources.json"), JSON.stringify({
      feeds: [{id:"public-feed",name:"Public feed",url:"https://example.com/feed"}], threads, githubTrending: true,
    }));
    write([{username:"Choi.OpenAI"}]);
    const noAuth = loadConfig({}, {projectRoot:root,requireNotion:false});
    assert.deepEqual(noAuth.sources.threads, [{username:"choi.openai"}]);
    assert.equal(noAuth.sources.rssFeeds.length, 1);
    assert.equal(noAuth.sources.githubTrending, true);
    const configured = loadConfig({THREADS_ACCESS_TOKEN:"test-secret"}, {projectRoot:root,requireNotion:false});
    assert.equal(configured.sources.threads![0]!.accessToken, "test-secret");
    assert.ok(configured.redaction.includes("test-secret"));
    for (const invalid of [[{username:"foo/bar"}], [{username:"Case"},{username:"case"}], "not-array"]) {
      write(invalid);
      assert.throws(() => loadConfig({}, {projectRoot:root,requireNotion:false}), /Threads|threads/);
    }
    write([]);
    assert.deepEqual(loadConfig({}, {projectRoot:root,requireNotion:false}).sources.threads, []);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
