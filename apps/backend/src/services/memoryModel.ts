import {
  createGoogleGenerativeAI,
} from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
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

/** Cheaper / utility model for summarization + memory extraction. */
export function getMemoryLlmModel(): LanguageModel {
  const modelId = env.VOICE_MEMORY_LLM_MODEL?.trim() || env.VOICE_LLM_MODEL;
  if (env.VOICE_LLM_PROVIDER === "google") {
    return getGoogle()(modelId);
  }
  if (env.VOICE_LLM_PROVIDER === "groq") {
    return getGroq()(modelId);
  }
  return getOpenAI()(modelId);
}

/** Pass into `generateText` / `streamText` when using Gemini for utility calls. */
export function getMemoryLlmProviderOptions(): {
  providerOptions?: { google: GoogleGenerativeAIProviderOptions };
} {
  if (env.VOICE_LLM_PROVIDER !== "google") return {};
  return {
    providerOptions: {
      google: {
        responseModalities: ["TEXT"],
      },
    },
  };
}
