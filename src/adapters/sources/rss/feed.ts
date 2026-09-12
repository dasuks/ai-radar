import { childrenNamed, deepText, findAll, firstChild, parseXml, textOf, type XmlElement } from "./xml.js";
import { stripHtml } from "../../shared/html.js";
import { hashParts } from "../../../domain/shared/ids.js";
import type { ContentCompleteness } from "../../../domain/documents/raw-observation.js";

/** 본문이 이 길이를 넘으면 FULL 로 본다. */
export const FULL_CONTENT_MIN_CHARS = 1500;

export type FeedKind = "rss" | "atom";

/** 피드 항목에서 뽑아낸 필드. RawObservation payload 의 `item` 이 된다. */
export interface RssFeedItem {
  externalId: string;
  guid: string | null;
  title: string | null;
  link: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  author: string | null;
  /** description / summary 원본 (HTML 일 수 있음) */
  summaryHtml: string | null;
  /** content:encoded / content 원본 (HTML 일 수 있음) */
  contentHtml: string | null;
  categories: string[];
  completeness: ContentCompleteness;
}

export interface ParsedFeedItem {
  item: RssFeedItem;
  rawXml: string;
}

export interface ParsedFeed {
  kind: FeedKind;
  feedTitle: string | null;
  items: ParsedFeedItem[];
}

/** RFC 822 / ISO 8601 → ISO 8601 UTC. 해석 불가면 null (fetchedAt 으로 채우지 않는다). */
export function parseFeedDate(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function atomLink(entry: XmlElement): string | null {
  const links = childrenNamed(entry, "link");
  const withHref = links.filter((link) => (link.attrs.href ?? "").trim() !== "");
  const alternate = withHref.find((link) => (link.attrs.rel ?? "alternate") === "alternate");
  const chosen = alternate ?? withHref[0];
  if (chosen) return (chosen.attrs.href ?? "").trim();
  return textOf(firstChild(entry, "link"));
}

function rssLink(item: XmlElement): string | null {
  const link = textOf(firstChild(item, "link"));
  if (link) return link;
  const guid = firstChild(item, "guid");
  const guidText = textOf(guid);
  if (guidText && /^https?:\/\//i.test(guidText)) return guidText;
  return null;
}

export function completenessOf(summaryHtml: string | null, contentHtml: string | null): ContentCompleteness {
  if (contentHtml) {
    const text = stripHtml(contentHtml);
    if (text.length > FULL_CONTENT_MIN_CHARS) return "FULL";
    if (text.length > 0) return "EXCERPT";
  }
  if (summaryHtml && stripHtml(summaryHtml).length > 0) return "EXCERPT";
  return "TITLE_ONLY";
}

function externalIdOf(guid: string | null, link: string | null, title: string | null, publishedAt: string | null): string {
  if (guid) return guid;
  if (link) return link;
  return `sha256:${hashParts(title ?? "", publishedAt ?? "").slice(0, 32)}`;
}

function parseRssItem(item: XmlElement): ParsedFeedItem {
  const guid = textOf(firstChild(item, "guid"));
  const link = rssLink(item);
  const title = textOf(firstChild(item, "title"));
  const publishedAt = parseFeedDate(textOf(firstChild(item, "pubdate", "dc:date", "date")));
  const updatedAt = parseFeedDate(textOf(firstChild(item, "atom:updated", "lastbuilddate")));
  const author = textOf(firstChild(item, "dc:creator", "author"));
  const summaryRaw = firstChild(item, "description");
  const contentRaw = firstChild(item, "content:encoded", "content");
  const summaryHtml = summaryRaw ? deepText(summaryRaw).trim() || null : null;
  const contentHtml = contentRaw ? deepText(contentRaw).trim() || null : null;
  const categories = childrenNamed(item, "category")
    .map((c) => textOf(c) ?? (c.attrs.term ?? "").trim())
    .filter((c) => c !== "");
  return {
    item: {
      externalId: externalIdOf(guid, link, title, publishedAt),
      guid,
      title,
      link,
      publishedAt,
      updatedAt,
      author,
      summaryHtml,
      contentHtml,
      categories,
      completeness: completenessOf(summaryHtml, contentHtml),
    },
    rawXml: item.raw,
  };
}

function parseAtomEntry(entry: XmlElement): ParsedFeedItem {
  const guid = textOf(firstChild(entry, "id"));
  const link = atomLink(entry);
  const title = textOf(firstChild(entry, "title"));
  const publishedAt = parseFeedDate(textOf(firstChild(entry, "published", "issued")));
  const updatedAt = parseFeedDate(textOf(firstChild(entry, "updated", "modified")));
  const authorElement = firstChild(entry, "author");
  const author = authorElement ? textOf(firstChild(authorElement, "name")) : null;
  const summaryRaw = firstChild(entry, "summary");
  const contentRaw = firstChild(entry, "content");
  const summaryHtml = summaryRaw ? deepText(summaryRaw).trim() || null : null;
  const contentHtml = contentRaw ? deepText(contentRaw).trim() || null : null;
  const categories = childrenNamed(entry, "category")
    .map((c) => (c.attrs.term ?? "").trim() || (textOf(c) ?? ""))
    .filter((c) => c !== "");
  return {
    item: {
      externalId: externalIdOf(guid, link, title, publishedAt ?? updatedAt),
      guid,
      title,
      link,
      publishedAt: publishedAt ?? updatedAt,
      updatedAt,
      author,
      summaryHtml,
      contentHtml,
      categories,
      completeness: completenessOf(summaryHtml, contentHtml),
    },
    rawXml: entry.raw,
  };
}

/** RSS 2.0 / Atom 문서를 읽는다. 항목을 하나도 인식하지 못하면 null. */
export function parseFeed(xml: string): ParsedFeed | null {
  const document = parseXml(xml);
  if (!document) return null;

  const rssItems = findAll(document, "item");
  if (rssItems.length > 0) {
    const channel = findAll(document, "channel")[0] ?? null;
    return {
      kind: "rss",
      feedTitle: channel ? textOf(firstChild(channel, "title")) : null,
      items: rssItems.map(parseRssItem),
    };
  }

  const entries = findAll(document, "entry");
  if (entries.length > 0) {
    const feed = findAll(document, "feed")[0] ?? null;
    return {
      kind: "atom",
      feedTitle: feed ? textOf(firstChild(feed, "title")) : null,
      items: entries.map(parseAtomEntry),
    };
  }

  const isFeedDocument = findAll(document, "rss").length > 0 || findAll(document, "feed").length > 0;
  if (isFeedDocument) {
    const feed = findAll(document, "channel")[0] ?? findAll(document, "feed")[0] ?? null;
    return { kind: findAll(document, "rss").length > 0 ? "rss" : "atom", feedTitle: feed ? textOf(firstChild(feed, "title")) : null, items: [] };
  }
  return null;
}
