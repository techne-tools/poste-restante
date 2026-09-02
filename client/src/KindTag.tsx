/**
 * Kind identity — distinct-but-quiet (DESIGN.md letter rule 4).
 * Each kind carries its own glyph in the mono voice; all render muted ink on
 * the sheet. Six legible kinds, not six loud badges.
 */

const KIND_META: Record<string, { glyph: string }> = {
  letter: { glyph: "l" },
  feed: { glyph: "f" },
  system: { glyph: "s" },
  audio: { glyph: "a" },
  note: { glyph: "n" },
  task: { glyph: "t" },
  invite: { glyph: "i" },
  clause: { glyph: "c" },
};

export default function KindTag({ kind }: { kind: string }) {
  const glyph = KIND_META[kind]?.glyph ?? "·";
  return (
    <span className="kind-tag" aria-label={`a ${kind} letter`}>
      <span className="glyph" aria-hidden="true">
        {glyph}
      </span>
      {kind}
    </span>
  );
}
