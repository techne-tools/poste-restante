import { describe, it, expect, vi } from "vitest";
import {
  WhisperTranscriber,
  NoopAudioTranscriber,
  createAudioTranscriber,
  normaliseWhisperLanguage,
} from "../../src/audio/transcriber.js";
import { AudioLetterService } from "../../src/audio/audio-service.js";
import type { PayloadStore } from "../../src/minio/store.js";
import type { Letter } from "../../src/types.js";

describe("normaliseWhisperLanguage", () => {
  it("reduces BCP-47 locales to the bare ISO 639-1 code faster-whisper accepts", () => {
    expect(normaliseWhisperLanguage("en-AU")).toBe("en");
    expect(normaliseWhisperLanguage("en")).toBe("en");
    expect(normaliseWhisperLanguage("pt-BR")).toBe("pt");
    expect(normaliseWhisperLanguage("zh-CN")).toBe("zh");
    expect(normaliseWhisperLanguage("yue-HK")).toBe("yue");
  });

  it("returns undefined for falsy or empty input", () => {
    expect(normaliseWhisperLanguage(undefined)).toBeUndefined();
    expect(normaliseWhisperLanguage("")).toBeUndefined();
    expect(normaliseWhisperLanguage("   ")).toBeUndefined();
  });
});

describe("WhisperTranscriber", () => {
  it("transcribes audio data via /asr endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: "We open on the stormy sea.", language: "en" }),
    } as unknown as Response);

    const client = new WhisperTranscriber("http://localhost:9000");
    const res = await client.transcribe(new Uint8Array([10, 20, 30]), "tempest.wav");

    expect(res.text).toBe("We open on the stormy sea.");
    expect(res.language).toBe("en");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:9000/asr?task=transcribe&output=json"),
      expect.objectContaining({ method: "POST" }),
    );

    globalThis.fetch = originalFetch;
  });

  it("normalises a full locale (en-AU) to the bare code before calling /asr", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: "Storm.", language: "en" }),
    } as unknown as Response);

    const client = new WhisperTranscriber("http://localhost:9000");
    await client.transcribe(new Uint8Array([10, 20, 30]), "storm.wav", "en-AU");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("language=en"),
      expect.objectContaining({ method: "POST" }),
    );
    // the raw locale must never reach the ASR service (it 500s)
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("language=en-AU"),
      expect.anything(),
    );

    globalThis.fetch = originalFetch;
  });

  it("createAudioTranscriber selects WhisperTranscriber when URL set", () => {
    const noop = createAudioTranscriber(undefined);
    expect(noop).toBeInstanceOf(NoopAudioTranscriber);

    const client = createAudioTranscriber("http://localhost:9000");
    expect(client).toBeInstanceOf(WhisperTranscriber);
  });
});

describe("AudioLetterService", () => {
  it("transcribes audio letter and ingests a new letter in the same thread", async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    const mockPayloadStore: PayloadStore = {
      put: vi.fn(),
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key === "letters/let_audio1/rehearsal.wav") return audioData;
        return null;
      }),
      delete: vi.fn(),
      listForLetter: vi.fn().mockResolvedValue(["letters/let_audio1/rehearsal.wav"]),
      deleteForLetter: vi.fn(),
    };

    const mockTranscriber = {
      transcribe: vi.fn().mockResolvedValue({
        text: "The cue happens right after the thunder rumble.",
        language: "en-AU",
      }),
    };

    let ingestedLetter: Letter | null = null;
    const mockIngest = vi.fn().mockImplementation(async (letter: Letter) => {
      ingestedLetter = letter;
      return { letterId: "let_transcript1", created: true };
    });

    const service = new AudioLetterService({
      payloadStore: mockPayloadStore,
      transcriber: mockTranscriber,
      ingest: mockIngest,
    });

    const audioLetter: Letter = {
      id: "let_audio1",
      envelope: {
        from: "director@house",
        to: ["sound@house"],
        cc: [],
        thread: "th_tempest_cues",
        kind: "audio",
        lang: "en-AU",
        subject: "cue 24 voice note",
      },
      time: {
        gregorian: "2026-09-06T13:00:00Z",
        frames: [{ frame: "production", value: "tempest-tech-week" }],
      },
      body: {
        format: "markdown",
        content: "Voice note recorded during rehearsal.",
      },
    };

    const res = await service.transcribeAudioLetter(audioLetter);
    expect(res).toEqual({ letterId: "let_transcript1", created: true });
    expect(mockTranscriber.transcribe).toHaveBeenCalledWith(
      audioData,
      "rehearsal.wav",
      "en-AU",
    );

    expect(ingestedLetter).not.toBeNull();
    const l = ingestedLetter! as Letter;
    expect(l.envelope.kind).toBe("letter");
    expect(l.envelope.from).toBe("director@house");
    expect(l.envelope.thread).toBe("th_tempest_cues");
    expect(l.envelope.subject).toBe("re: [transcript] cue 24 voice note");
    expect(l.time.frames).toEqual([{ frame: "production", value: "tempest-tech-week" }]);
    expect(l.body.content).toContain("The cue happens right after the thunder rumble.");
  });

  it("returns null if no payload has been uploaded yet", async () => {
    const mockPayloadStore: PayloadStore = {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      listForLetter: vi.fn().mockResolvedValue([]),
      deleteForLetter: vi.fn(),
    };

    const service = new AudioLetterService({
      payloadStore: mockPayloadStore,
      transcriber: { transcribe: vi.fn() },
      ingest: vi.fn(),
    });

    const audioLetter: Letter = {
      id: "let_empty",
      envelope: {
        from: "you@house",
        to: ["hermes@house"],
        cc: [],
        thread: "th_test",
        kind: "audio",
        lang: "en-AU",
        subject: "test",
      },
      time: { gregorian: "2026-09-06T12:00:00Z", frames: [] },
      body: { format: "markdown", content: "" },
    };

    const res = await service.transcribeAudioLetter(audioLetter);
    expect(res).toBeNull();
  });
});
