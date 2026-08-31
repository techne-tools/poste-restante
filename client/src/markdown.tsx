/**
 * The letter's markdown — a minimal renderer, deliberately small.
 *
 * The house assumes markdown from day one (CONTRACT §The Letter), but the
 * reference client is a guide, not a bible: no full spec, no HTML passthrough,
 * no dangerouslySetInnerHTML. Blocks: headings, blockquotes, lists, paragraphs.
 * Inline: bold, italic, code, links. Everything else stays literal.
 */

import type { ReactNode } from "react";

/** Inline tokens, tried in order: code first, so `**` inside code is not emphasis. */
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  // matchAll clones the regex per iterator, so the recursive call for link
  // text can never disturb the outer loop's position (a shared lastIndex
  // would restart the scan and loop forever).
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [full, code, bold, italic, link] = m;
    if (code) {
      out.push(<code key={`${keyBase}-${i}`}>{code.slice(1, -1)}</code>);
    } else if (bold) {
      out.push(<strong key={`${keyBase}-${i}`}>{bold.slice(2, -2)}</strong>);
    } else if (italic) {
      out.push(<em key={`${keyBase}-${i}`}>{italic.slice(1, -1)}</em>);
    } else if (link) {
      const m2 = link.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (m2) {
        out.push(
          <a key={`${keyBase}-${i}`} href={m2[2]}>
            {renderInline(m2[1]!, `${keyBase}-${i}-l`)}
          </a>,
        );
      } else {
        out.push(full);
      }
    } else {
      out.push(full);
    }
    last = m.index + full.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render a letter body (markdown) to React nodes. */
export function renderMarkdown(content: string): ReactNode {
  const lines = content.split("\n");
  const out: ReactNode[] = [];
  let inList = false;
  let list: ReactNode[] = [];

  const flushList = (key: string) => {
    if (inList) {
      out.push(<ul key={key}>{list}</ul>);
      list = [];
      inList = false;
    }
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList(`list-${i}`);
      return;
    }
    const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushList(`list-${i}`);
      const level = h[1]!.length;
      const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as
        | "h1"
        | "h2"
        | "h3";
      out.push(<Tag key={i}>{renderInline(h[2]!, `h-${i}`)}</Tag>);
      return;
    }
    const bq = trimmed.match(/^>\s?(.*)$/);
    if (bq) {
      flushList(`list-${i}`);
      out.push(<blockquote key={i}>{renderInline(bq[1]!, `q-${i}`)}</blockquote>);
      return;
    }
    const li = trimmed.match(/^[-*]\s+(.*)$/);
    if (li) {
      inList = true;
      list.push(<li key={i}>{renderInline(li[1]!, `li-${i}`)}</li>);
      return;
    }
    flushList(`list-${i}`);
    out.push(<p key={i}>{renderInline(trimmed, `p-${i}`)}</p>);
  });
  flushList("list-end");
  return out;
}

/** A letter's first line — markdown reduced to plain text, for the rows.
 *  Links become their text; emphasis markers, headings, quotes and code
 *  ticks are stripped; runs of whitespace collapse. */
export function snippet(content: string, max = 120): string {
  return content
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
