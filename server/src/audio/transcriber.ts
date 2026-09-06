import type { Logger } from "../pipeline/logger.js";

export interface TranscribeResult {
  text: string;
  language?: string;
}

/**
 * Audio transcriber interface.
 *
 * Plugs into faster-whisper (onerahmet/openai-whisper-asr-webservice)
 * on the host (port 9000, SPEC §3.1 / §3.2).
 */
export interface AudioTranscriber {
  transcribe(
    audioData: Uint8Array,
    filename?: string,
    language?: string,
  ): Promise<TranscribeResult>;
}

export class NoopAudioTranscriber implements AudioTranscriber {
  async transcribe(): Promise<TranscribeResult> {
    throw new Error("Audio transcriber is disabled (WHISPER_URL unset)");
  }
}

/**
 * Client for faster-whisper ASR web service.
 * Supports both onerahmet/openai-whisper-asr-webservice (/asr endpoint)
 * and standard OpenAI-compatible /v1/audio/transcriptions.
 */
export class WhisperTranscriber implements AudioTranscriber {
  private readonly baseUrl: string;

  constructor(
    whisperUrl: string,
    private readonly log?: Logger,
  ) {
    this.baseUrl = whisperUrl.replace(/\/+$/, "");
  }

  async transcribe(
    audioData: Uint8Array,
    filename = "recording.wav",
    language?: string,
  ): Promise<TranscribeResult> {
    const formData = new FormData();
    const blob = new Blob([Buffer.from(audioData)], { type: "audio/wav" });
    formData.append("audio_file", blob, filename);

    // Primary: onerahmet/openai-whisper-asr-webservice endpoint
    const url = new URL(`${this.baseUrl}/asr`);
    url.searchParams.set("task", "transcribe");
    url.searchParams.set("output", "json");
    if (language) {
      url.searchParams.set("language", language);
    }

    this.log?.info("whisper:transcribe-start", {
      filename,
      bytes: audioData.byteLength,
    });

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const json = (await res.json()) as { text?: string; language?: string };
        const text = (json.text ?? "").trim();
        this.log?.info("whisper:transcribe-success", {
          length: text.length,
          language: json.language,
        });
        return { text, language: json.language };
      }

      // Fallback: OpenAI compatible endpoint (/v1/audio/transcriptions)
      if (res.status === 404) {
        return await this.transcribeOpenAI(audioData, filename, language);
      }

      const errText = await res.text().catch(() => "");
      throw new Error(`Whisper ASR error ${res.status}: ${errText}`);
    } catch (err) {
      this.log?.error("whisper:transcribe-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async transcribeOpenAI(
    audioData: Uint8Array,
    filename: string,
    language?: string,
  ): Promise<TranscribeResult> {
    const formData = new FormData();
    const blob = new Blob([Buffer.from(audioData)], { type: "audio/wav" });
    formData.append("file", blob, filename);
    formData.append("model", "whisper-1");
    if (language) formData.append("language", language);

    const res = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Whisper OpenAI ASR error ${res.status}: ${errText}`);
    }

    const json = (await res.json()) as { text?: string; language?: string };
    return { text: (json.text ?? "").trim(), language: json.language };
  }
}

export function createAudioTranscriber(
  whisperUrl?: string,
  log?: Logger,
): AudioTranscriber {
  if (whisperUrl) {
    return new WhisperTranscriber(whisperUrl, log);
  }
  return new NoopAudioTranscriber();
}
