import type { Letter } from "../types.js";
import type { PayloadStore } from "../minio/store.js";
import type { IngestResult } from "../pipeline/pipeline.js";
import type { AudioTranscriber } from "./transcriber.js";
import type { Logger } from "../pipeline/logger.js";
import { letterIdFromCanonical, canonicaliseLegacy } from "../id.js";

export interface AudioLetterServiceOptions {
  payloadStore?: PayloadStore;
  transcriber?: AudioTranscriber;
  ingest: (letter: Letter) => Promise<IngestResult>;
  log?: Logger;
}

/**
 * Audio letter service (CONTRACT.md / SPEC §3.1 / §3.2).
 *
 * "audio: a letter that is sound (voice memo, rehearsal recording) —
 *  whisper transcribes it into a *new* letter."
 *
 * Plural-time frames, thread references, and correspondents are preserved.
 */
export class AudioLetterService {
  constructor(private readonly options: AudioLetterServiceOptions) {}

  /**
   * Transcribe an audio letter using its raw payload in the payload store,
   * and ingest the resulting transcript as a new letter in the same thread.
   */
  async transcribeAudioLetter(
    audioLetter: Letter,
    preferredKey?: string,
  ): Promise<IngestResult | null> {
    if (audioLetter.envelope.kind !== "audio") {
      throw new Error(`Letter is not an audio letter (kind: ${audioLetter.envelope.kind})`);
    }

    if (!this.options.transcriber || !this.options.payloadStore) {
      this.options.log?.info("audio:transcribe-skipped", { reason: "disabled" });
      return null;
    }

    const id = audioLetter.id ?? letterIdFromCanonical(canonicaliseLegacy(audioLetter));

    // 1. Locate the payload
    let targetKey = preferredKey;
    if (!targetKey) {
      const keys = await this.options.payloadStore.listForLetter(id);
      if (keys.length === 0 || !keys[0]) {
        this.options.log?.info("audio:awaiting-payload", { letterId: id });
        return null;
      }
      targetKey = keys[0];
    }

    if (!targetKey) {
      return null;
    }

    // 2. Fetch the raw audio data
    const data = await this.options.payloadStore.get(targetKey);
    if (!data) {
      this.options.log?.error("audio:payload-not-found", {
        letterId: id,
        key: targetKey,
      });
      return null;
    }

    const filename = targetKey.split("/").pop() ?? "recording.wav";

    // 3. Transcribe via faster-whisper
    this.options.log?.info("audio:transcribing", { letterId: id, key: targetKey });
    const res = await this.options.transcriber.transcribe(
      data,
      filename,
      audioLetter.envelope.lang,
    );

    // 4. Create the transcript letter
    const transcriptLetter: Letter = {
      envelope: {
        from: audioLetter.envelope.from,
        to: audioLetter.envelope.to,
        cc: audioLetter.envelope.cc,
        thread: audioLetter.envelope.thread,
        kind: "letter",
        lang: res.language ?? audioLetter.envelope.lang ?? "en-AU",
        subject: audioLetter.envelope.subject.startsWith("re: ")
          ? `re: [transcript] ${audioLetter.envelope.subject.replace(/^re:\s*/, "")}`
          : `re: [transcript] ${audioLetter.envelope.subject}`,
      },
      time: {
        gregorian: new Date().toISOString(),
        frames: [...audioLetter.time.frames],
      },
      body: {
        format: "markdown",
        content: `*Transcript of audio letter from ${audioLetter.envelope.from}*\n\n${res.text.trim()}\n`,
      },
    };

    // 5. Ingest into the archive
    const ingestRes = await this.options.ingest(transcriptLetter);
    this.options.log?.info("audio:transcribed-and-stored", {
      audioLetterId: id,
      transcriptLetterId: ingestRes.letterId,
    });

    return ingestRes;
  }
}
