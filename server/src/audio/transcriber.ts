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
 * Normalise a BCP-47 / locale language tag to the ISO 639-1 code
 * faster-whisper accepts. The house's envelopes carry full locales
 * (lang: "en-AU" is the default); the ASR service only accepts bare
 * codes ("en", "pt", "zh", ...). Taking the primary subtag handles
 * every real case: en-AU → en, pt-BR → pt, zh-CN → zh, yue-HK → yue.
 */
export function normaliseWhisperLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const tag = language.trim().toLowerCase().split("-")[0];
  return tag || undefined;
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
    // faster-whisper accepts only bare ISO 639-1 codes — the house's
    // envelopes carry full locales (lang: "en-AU" is the default), so
    // normalise before we put the language on the wire (a 500 from the
    // ASR service otherwise).
    const lang = normaliseWhisperLanguage(language);
    const url = new URL(`${this.baseUrl}/asr`);
    url.searchParams.set("task", "transcribe");
    url.searchParams.set("output", "json");
    if (lang) {
      url.searchParams.set("language", lang);
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
    const lang = normaliseWhisperLanguage(language);
    if (lang) formData.append("language", lang);

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
