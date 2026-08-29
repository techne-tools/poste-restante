/**
 * Markdown → plain text. The body is markdown; the plain-text form is what gets
 * embedded (qdrant) and indexed for full-text (postgres FTS).
 *
 * This is a deliberately small, dependency-free extractor. It strips markdown
 * syntax while keeping the words, so "the letter where we discussed the sound
 * design" is findable. It is not a full markdown renderer — the house stores
 * the raw markdown and renders it in the client.
 */
export function markdownToText(markdown: string): string {
  return markdown
    // Code fences: keep the code text (it may be the content of the letter).
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1")
    // Inline code.
    .replace(/`([^`]+)`/g, "$1")
    // Images: keep alt text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Links: keep the link text.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Headings, blockquotes, list markers, horizontal rules.
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    // Emphasis and strikethrough.
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    // Collapse whitespace.
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
