import type { ReactNode } from "react";

interface Props {
  /** The quiet door-word: mono, short — what the note is about. */
  summary: string;
  /** The distilled explanation. Not simplified: the thought, held whole. */
  children: ReactNode;
}

/**
 * A quiet explanation — the house's own way of showing its reasoning.
 *
 * Same shape as the whisper's "here's what I was seeing": a details block
 * the reader opens when they want the thinking behind a surface. Never a
 * popup, never a hover — presence not pressure: the explanation waits, it
 * does not interrupt. The door-word is the machine's (mono); the body is
 * the reader's (sans) or the writer's (serif), whichever the surface asks.
 */
export default function WhyNote({ summary, children }: Props) {
  return (
    <details className="why-note">
      <summary className="why-note-summary">{summary}</summary>
      <div className="details-body">{children}</div>
    </details>
  );
}
