/**
 * The letter — the atomic unit's reading states.
 *
 * Locked here: a plain letter reads as a letter; a sealed letter shows the
 * "sealed letter" title and its open affordance, and never leaks the
 * ciphertext; and an enclosure row distinguishes a pending file from a
 * delivered enclosure's confirmed deletion.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LetterView from "./LetterView";
import Enclosures from "./Enclosures";
import type { Letter, PayloadMeta } from "./api";

const noop = () => {};

function letter(over: Partial<Letter> = {}): Letter {
  const base: Letter = {
    id: "l_1",
    envelope: {
      from: "hermes@house",
      to: ["chris@house"],
      cc: [],
      thread: "th_9f2c1",
      kind: "letter",
      lang: "en-AU",
      subject: "On the winter of the show",
    },
    time: {
      gregorian: "2026-09-12T09:14:00+04:00",
      frames: [{ frame: "season", value: "autumn" }],
    },
    body: { format: "markdown", content: "the storm cue moves to 47." },
    receivedAt: "2026-09-12T09:14:00+04:00",
    pinnedAt: null,
    pinnedBy: null,
  };
  return { ...base, ...over };
}

function payload(over: Partial<PayloadMeta> = {}): PayloadMeta {
  return {
    key: "letters/l_1/memo.wav",
    name: "memo.wav",
    contentType: "audio/wav",
    size: 1_258_291,
    ...over,
  };
}

describe("LetterView — the letter reads as a letter", () => {
  it("renders the envelope, subject, frames, body, and signoff", () => {
    const html = renderToStaticMarkup(<LetterView letter={letter()} onBack={noop} />);
    expect(html).toContain("to: chris@house");
    expect(html).toContain("from: hermes@house");
    expect(html).toContain("On the winter of the show");
    expect(html).toContain("season:autumn");
    expect(html).toContain("the storm cue moves to 47.");
    expect(html).toContain("— hermes@house");
    // The machine metadata stays one quiet disclosure away.
    expect(html).toContain("thread: th_9f2c1");
    // The way back is one class (adherence rule 10).
    expect(html).toContain('class="back"');
  });

  it("shows a sealed letter as 'sealed letter' and never renders the ciphertext", () => {
    const sealed = letter({
      envelope: { ...letter().envelope, subject: "" },
      body: {
        format: "sealed",
        content: "age1ciphertext-armored",
        recipients: [],
        signature: "sig",
      },
    });
    const html = renderToStaticMarkup(<LetterView letter={sealed} onBack={noop} />);
    expect(html).toContain("sealed letter");
    expect(html).toContain("Open the sealed letter");
    // The envelope is visible; the body waits. The armor never appears.
    expect(html).not.toContain("age1ciphertext-armored");
  });
});

describe("Enclosures — what a letter carries", () => {
  const base = {
    blobs: {} as Record<string, string>,
    failed: {} as Record<string, string>,
    confirmRemove: null as string | null,
    onAskRemove: noop,
    onCancelRemove: noop,
    onRemove: noop,
    onDownload: noop,
  };

  it("renders nothing when the letter carries nothing", () => {
    const html = renderToStaticMarkup(<Enclosures payloads={[]} {...base} />);
    expect(html).toBe("");
  });

  it("renders an image and audio in place, and a file as a download", () => {
    const payloads = [
      payload({ name: "memo.wav", contentType: "audio/wav" }),
      payload({ name: "score.png", contentType: "image/png", size: 2048 }),
      payload({ name: "notes.pdf", contentType: "application/pdf", size: 500 }),
    ];
    const html = renderToStaticMarkup(
      <Enclosures
        payloads={payloads}
        {...base}
        blobs={{ "memo.wav": "blob:audio", "score.png": "blob:image" }}
      />,
    );
    expect(html).toContain('class="enclosure-image"');
    expect(html).toContain('src="blob:image"');
    expect(html).toContain('class="enclosure-audio"');
    expect(html).toContain('src="blob:audio"');
    expect(html).toContain('class="enclosure-download"');
    expect(html).toContain("download");
  });

  it("shows a quiet pending state before the bytes arrive", () => {
    const html = renderToStaticMarkup(
      <Enclosures
        payloads={[payload({ name: "score.png", contentType: "image/png", size: 10 })]}
        {...base}
      />,
    );
    expect(html).toContain("opening…");
    expect(html).not.toContain("enclosure-image");
  });

  it("confirms a delivered enclosure's removal", () => {
    const payloads = [payload({ name: "memo.wav" })];

    const resting = renderToStaticMarkup(
      <Enclosures payloads={payloads} {...base} confirmRemove={null} />,
    );
    expect(resting).toContain(">×</button>");
    expect(resting).toContain("this deletes it for everyone");
    expect(resting).not.toContain("Yes, remove it");

    const confirming = renderToStaticMarkup(
      <Enclosures payloads={payloads} {...base} confirmRemove="memo.wav" />,
    );
    expect(confirming).toContain("Remove memo.wav? It goes for everyone addressed.");
    expect(confirming).toContain("Yes, remove it");
    expect(confirming).toContain("Keep it");
    expect(confirming).not.toContain("this deletes it for everyone");
  });
});
