/** Selectable voice-assistant speaking styles (sent on `voice:start`). */
export const VOICE_PERSONA_IDS = ["jolly", "energetic", "sad", "sarcastic"] as const;
export type VoicePersonaId = (typeof VOICE_PERSONA_IDS)[number];

export function isVoicePersonaId(value: unknown): value is VoicePersonaId {
  return typeof value === "string" && (VOICE_PERSONA_IDS as readonly string[]).includes(value);
}

/** UI copy for persona picker (single source of truth). */
export const VOICE_PERSONA_OPTIONS: ReadonlyArray<{
  id: VoicePersonaId;
  label: string;
  hint: string;
}> = [
  { id: "jolly", label: "Jolly", hint: "Warm, playful, easy smile in the voice" },
  { id: "energetic", label: "Energetic", hint: "Upbeat, punchy, lively" },
  { id: "sad", label: "Melancholy", hint: "Soft, subdued, gentle weight" },
  { id: "sarcastic", label: "Sarcastic", hint: "Dry wit, playful deadpan" },
];
