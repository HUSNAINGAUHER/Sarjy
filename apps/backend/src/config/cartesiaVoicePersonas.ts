import { env } from "@/config/env";
import type { GenerationConfig } from "@cartesia/cartesia-js/resources/tts/tts";
import type { VoicePersonaId } from "@sarjy/shared-types";

type CartesiaEmotion = NonNullable<GenerationConfig["emotion"]>;

/** Cartesia Sonic-3+ `generation_config.emotion` values (ignored on older models). */
const PERSONA_EMOTION: Record<VoicePersonaId, CartesiaEmotion> = {
  jolly: "happy",
  energetic: "excited",
  sad: "melancholic",
  sarcastic: "sarcastic",
};

function voiceIdForPersona(persona: VoicePersonaId): string {
  switch (persona) {
    case "jolly":
      return env.CARTESIA_VOICE_JOLLY?.trim() || env.CARTESIA_TTS_VOICE_ID;
    case "energetic":
      return env.CARTESIA_VOICE_ENERGETIC?.trim() || env.CARTESIA_TTS_VOICE_ID;
    case "sad":
      return env.CARTESIA_VOICE_SAD?.trim() || env.CARTESIA_TTS_VOICE_ID;
    case "sarcastic":
      return env.CARTESIA_VOICE_SARCASTIC?.trim() || env.CARTESIA_TTS_VOICE_ID;
    default:
      return env.CARTESIA_TTS_VOICE_ID;
  }
}

/**
 * Per-persona Cartesia voice + emotion for streaming TTS (`context.send` / bytes API).
 * Voice ids default to `CARTESIA_TTS_VOICE_ID`; set `CARTESIA_VOICE_*` env vars to use different library voices.
 */
export function getCartesiaPersonaTtsSettings(persona: VoicePersonaId): {
  voiceId: string;
  generation_config: GenerationConfig;
} {
  return {
    voiceId: voiceIdForPersona(persona),
    generation_config: { emotion: PERSONA_EMOTION[persona] },
  };
}
