/**
 * RSS 2.0 / Atom fixture. 손으로 줄여 캡처한 문자열이며 테스트 중 네트워크를 쓰지 않는다.
 */

/** FULL 판정(본문 1500자 초과)을 넘기기 위한 패딩 문단. */
const LONG_PARAGRAPH = "The release notes describe the evaluation harness, the context handling and the pricing in detail. ".repeat(
  20,
);

export const RSS_FEED_URL = "https://example.com/feed.xml";
export const ATOM_FEED_URL = "https://blog.example.org/atom.xml";

export const RSS_ITEM_GUID = "tag:example.com,2026:claude-opus-5";
export const RSS_EDGE_GUID = "https://example.com/edge-models";
export const ATOM_MCP_ID = "tag:blog.example.org,2026:mcp-turns-one";
export const ATOM_AGENTS_ID = "tag:blog.example.org,2026:agents-read-repo";

export const RSS_2_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example AI Weekly</title>
    <link>https://example.com/</link>
    <description>AI releases, summarised</description>
    <item>
      <title>Claude Opus 5 ships a 1M token context window</title>
      <link>https://example.com/claude-opus-5?utm_source=feed&amp;utm_medium=rss</link>
      <guid isPermaLink="false">${RSS_ITEM_GUID}</guid>
      <pubDate>Sat, 12 Sep 2026 06:30:00 GMT</pubDate>
      <dc:creator>Sam Writer</dc:creator>
      <category>models</category>
      <description>Anthropic &amp;amp; friends shipped &amp;lt;em&amp;gt;Opus 5&amp;lt;/em&amp;gt; today.</description>
      <content:encoded><![CDATA[<p>${LONG_PARAGRAPH}</p><p>Read the <a href="https://example.com/claude-opus-5/notes">full notes</a>.</p>]]></content:encoded>
    </item>
    <item>
      <title>Small models on the edge</title>
      <link>https://example.com/edge-models</link>
      <guid>${RSS_EDGE_GUID}</guid>
      <pubDate>Sat, 12 Sep 2026 09:15:00 GMT</pubDate>
      <description>&lt;p&gt;Tom &amp;amp; Jerry benchmarked a 3B model.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Old post about transformers</title>
      <link>https://example.com/old-transformers</link>
      <guid>https://example.com/old-transformers</guid>
      <pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
      <description>Archive entry.</description>
    </item>
  </channel>
</rss>
`;

export const ATOM_FEED_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Engineering Blog</title>
  <link rel="self" type="application/atom+xml" href="${ATOM_FEED_URL}"/>
  <updated>2026-09-12T10:05:00Z</updated>
  <entry>
    <title>Model Context Protocol turns one</title>
    <link rel="edit" href="https://blog.example.org/edit/mcp-turns-one"/>
    <link rel="alternate" type="text/html" href="https://blog.example.org/mcp-turns-one"/>
    <id>${ATOM_MCP_ID}</id>
    <published>2026-09-12T05:00:00Z</published>
    <updated>2026-09-12T05:05:00Z</updated>
    <author><name>Jane Doe</name></author>
    <category term="protocols"/>
    <summary type="html">&lt;p&gt;MCP &amp;amp; the year ahead.&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>Agents that read your repo</title>
    <link href="https://blog.example.org/agents-read-repo"/>
    <id>${ATOM_AGENTS_ID}</id>
    <published>2026-09-12T10:00:00Z</published>
    <author><name>Jane Doe</name></author>
    <content type="html"><![CDATA[<p>${LONG_PARAGRAPH}</p><p>See also <a href="https://example.com/claude-opus-5">Opus 5</a>.</p>]]></content>
  </entry>
</feed>
`;
