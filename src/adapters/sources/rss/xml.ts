import { decodeEntities } from "./html.js";

/**
 * 손으로 쓴 최소 XML 리더 (의존성 없음).
 *
 * RSS 2.0 / Atom 피드를 읽을 수 있을 만큼만 구현한다:
 * 요소, 속성, self-closing, CDATA, 주석, XML 선언, DOCTYPE, 엔티티 디코딩.
 * 네임스페이스는 해석하지 않고 접두사를 포함한 이름을 소문자로 보관한다 (`content:encoded`).
 * 검증기가 아니라 리더이므로, 닫히지 않은 태그는 문서 끝에서 닫힌 것으로 본다.
 */
export interface XmlElement {
  /** 소문자 태그 이름 (접두사 포함) */
  name: string;
  /** 소문자 속성 이름 → 디코딩된 값 */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** 이 요소가 직접 가진 텍스트 (엔티티 디코딩됨, CDATA 포함) */
  text: string;
  /** 원본 XML 조각 (`<item>…</item>`) */
  raw: string;
  /** 원본에서의 시작 오프셋 (내부용) */
  start: number;
}

const ROOT_NAME = "#document";

function createElement(name: string, attrs: Record<string, string>, start: number): XmlElement {
  return { name, attrs, children: [], text: "", raw: "", start };
}

/** 따옴표 안의 `>` 를 건너뛰며 태그 끝을 찾는다. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

const ATTR_PATTERN = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseOpenTag(body: string): { name: string; attrs: Record<string, string> } {
  const trimmed = body.trim();
  const match = /^([A-Za-z_:][-A-Za-z0-9_:.]*)/.exec(trimmed);
  const name = (match?.[1] ?? "").toLowerCase();
  const attrs: Record<string, string> = {};
  const rest = trimmed.slice(match?.[1]?.length ?? 0);
  for (const attr of rest.matchAll(ATTR_PATTERN)) {
    const key = (attr[1] ?? "").toLowerCase();
    const value = attr[3] ?? attr[4] ?? attr[5] ?? "";
    if (key) attrs[key] = decodeEntities(value);
  }
  return { name, attrs };
}

/** XML 문서를 읽어 가상 루트(`#document`)를 돌려준다. 파싱할 수 없으면 null. */
export function parseXml(source: string): XmlElement | null {
  if (typeof source !== "string" || source.trim() === "") return null;
  const root = createElement(ROOT_NAME, {}, 0);
  const stack: XmlElement[] = [root];
  let index = 0;

  const top = (): XmlElement => stack[stack.length - 1] ?? root;

  while (index < source.length) {
    const lt = source.indexOf("<", index);
    if (lt < 0) {
      top().text += decodeEntities(source.slice(index));
      break;
    }
    if (lt > index) top().text += decodeEntities(source.slice(index, lt));

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      top().text += source.slice(lt + 9, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("<!", lt)) {
      const end = findTagEnd(source, lt + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt + 1);
    if (gt < 0) break;
    const inner = source.slice(lt + 1, gt);

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        const candidate = stack[depth];
        if (candidate && candidate.name === name) {
          candidate.raw = source.slice(candidate.start, gt + 1);
          stack.length = depth;
          break;
        }
      }
      index = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const { name, attrs } = parseOpenTag(selfClosing ? inner.slice(0, -1) : inner);
    if (!name) {
      index = gt + 1;
      continue;
    }
    const element = createElement(name, attrs, lt);
    top().children.push(element);
    if (selfClosing) element.raw = source.slice(lt, gt + 1);
    else stack.push(element);
    index = gt + 1;
  }

  // 닫히지 않은 요소는 문서 끝에서 닫힌 것으로 본다.
  for (let depth = stack.length - 1; depth > 0; depth -= 1) {
    const open = stack[depth];
    if (open && open.raw === "") open.raw = source.slice(open.start);
  }
  root.raw = source;
  return root;
}

/** 주어진 이름 중 첫 번째로 일치하는 자식. */
export function firstChild(element: XmlElement, ...names: string[]): XmlElement | null {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const child of element.children) {
    if (wanted.has(child.name)) return child;
  }
  return null;
}

/** 주어진 이름의 모든 자식. */
export function childrenNamed(element: XmlElement, ...names: string[]): XmlElement[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return element.children.filter((child) => wanted.has(child.name));
}

/** 문서 전체에서 주어진 이름의 요소를 깊이 우선으로 모은다. */
export function findAll(element: XmlElement, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  const out: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === wanted) out.push(child);
      walk(child);
    }
  };
  walk(element);
  return out;
}

/** 요소와 자손의 텍스트를 이어 붙인다 (Atom `type="xhtml"` 대비). */
export function deepText(element: XmlElement | null): string {
  if (!element) return "";
  let out = element.text;
  for (const child of element.children) out += deepText(child);
  return out;
}

/** 텍스트를 trim 해서 돌려준다. 비면 null. */
export function textOf(element: XmlElement | null): string | null {
  const value = deepText(element).trim();
  return value === "" ? null : value;
}
