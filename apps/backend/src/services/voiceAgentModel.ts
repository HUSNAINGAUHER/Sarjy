import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProviderOptions,
} from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "@/config/env";

let openaiProvider: ReturnType<typeof createOpenAI> | null = null;
let googleProvider: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let groqProvider: ReturnType<typeof createGroq> | null = null;

function getOpenAI() {
  if (!openaiProvider) {
    openaiProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY! });
  }
  return openaiProvider;
}

function getGoogle() {
  if (!googleProvider) {
    googleProvider = createGoogleGenerativeAI({
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY!,
    });
  }
  return googleProvider;
}

function getGroq() {
  if (!groqProvider) {
    groqProvider = createGroq({ apiKey: env.GROQ_API_KEY! });
  }
  return groqProvider;
}

/**
 * Chat model for voice. Pipeline is STT → plain-text user message → \`streamText\` → TTS (no audio to the LLM).
 */
export function getVoiceAgentModel(): LanguageModel {
  if (env.VOICE_LLM_PROVIDER === "google") {
    return getGoogle()(env.VOICE_LLM_MODEL);
  }
  if (env.VOICE_LLM_PROVIDER === "groq") {
    return getGroq()(env.VOICE_LLM_MODEL);
  }
  return getOpenAI()(env.VOICE_LLM_MODEL);
}

/**
 * Gemini-only: restrict generation to text modality so the path stays text-in / text-out
 * (avoid image / native-audio style responses for this socket pipeline).
 */
export function getVoiceAgentStreamTextOverrides(): {
  providerOptions?: { google: GoogleGenerativeAIProviderOptions };
} {
  if (env.VOICE_LLM_PROVIDER !== "google") return {};
  return {
    providerOptions: {
      google: {
        responseModalities: ["TEXT"],
        // Disable "thinking" on gemini-2.5-* — for sub-second voice TTFT we need
        // tokens to start streaming immediately. A non-zero thinking budget adds
        // 1–3s of pre-stream latency with no quality benefit for short voice replies.
        thinkingConfig: {
          thinkingBudget: 0,
          includeThoughts: false,
        },
      },
    },
  };
}
