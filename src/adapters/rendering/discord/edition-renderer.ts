import { contentHashOf, type Artifact } from "../../../domain/artifacts/artifact.js";
import { parseDiscordEdition, type DiscordDeliveryPayload, type DiscordEditionBody } from "../../../domain/artifacts/discord-edition.js";
import type { Rendered, Renderer } from "../../../ports/publishing/index.js";

function escape(value: string): string { return value.replace(/([\\`*_~|\[\]<>])/g, "\\$1"); }

export class DiscordEditionRenderer implements Renderer<DiscordEditionBody> {
  readonly channel = "discord" as const;
  render(artifact: Artifact<DiscordEditionBody>): Rendered {
    const body = parseDiscordEdition(artifact.body);
    const payload: DiscordDeliveryPayload = {
      date: body.date,
      posts: body.posts.map((post) => {
        const prose = [escape(post.summary), escape(post.detail)];
        if (post.example) prose.push(`**${body.bodySchemaVersion === 1 ? "활용 예시 (가상 시나리오)" : "활용 예시"}** ${escape(post.example)}`);
        if (post.caveat) prose.push(`**유의할 점** ${escape(post.caveat)}`);
        if ("evidenceLabel" in post) prose.push(`**근거** ${escape(post.evidenceLabel)}`);
        const content = [
          `## ${escape(post.title)}`, prose.join("\n\n"),
          post.links.map((link) => `[${escape(link.label)}](<${link.url}>)`).join(" · "),
          `${body.date} · 수정 ${artifact.revision}`,
        ].join("\n\n");
        if (content.length > 2000) throw new Error("Discord post exceeds 2000 characters; shorten prose while retaining every source link");
        return { key: post.id, channel: post.sector, title: post.title, summary: post.summary, content };
      }),
    };
    return { channel: this.channel, hash: contentHashOf(payload), payload, preview: payload.posts.map((post) => `[${post.channel}]\n${post.content}`).join("\n\n---\n\n") };
  }
}
