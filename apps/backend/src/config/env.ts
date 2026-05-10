import "dotenv/config";
import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),
    DEEPGRAM_API_KEY: z.string().min(1, "DEEPGRAM_API_KEY is required"),
    // Override to "nova-2" if your plan doesn't include Flux (flux-general-en)
    DEEPGRAM_STT_MODEL: z.string().default("flux-general-en"),
    VOICE_TTS_PROVIDER: z.enum(["deepgram", "cartesia"]).default("deepgram"),
    CARTESIA_API_KEY: z.string().optional(),
    CARTESIA_TTS_MODEL: z.string().default("sonic-2"),
    CARTESIA_TTS_VOICE_ID: z.string().default("694f9389-aac1-45b6-b726-9d9369183238"),
    /** Optional per-persona Cartesia voice ids (default: CARTESIA_TTS_VOICE_ID). */
    CARTESIA_VOICE_JOLLY: z.string().optional(),
    CARTESIA_VOICE_ENERGETIC: z.string().optional(),
    CARTESIA_VOICE_SAD: z.string().optional(),
    CARTESIA_VOICE_SARCASTIC: z.string().optional(),

    /** Voice LLM: Google Gemini, OpenAI, or Groq (text in / text out — STT supplies transcript only). */
    VOICE_LLM_PROVIDER: z.enum(["google", "openai", "groq"]).default("google"),
    OPENAI_API_KEY: z.string().optional(),
    /** Required when VOICE_LLM_PROVIDER=groq (e.g. llama-3.1-8b-instant). */
    GROQ_API_KEY: z.string().optional(),
    /** Google AI Studio / Vertex-style key for Gemini text models */
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    /**
     * Model id for the selected provider. Use a text chat model — not native-audio / TTS preview ids.
     * Google examples: gemini-2.0-flash, gemini-2.5-flash, gemini-2.5-flash-lite
     * Groq examples: llama-3.1-8b-instant, llama-3.3-70b-versatile
     */
    VOICE_LLM_MODEL: z.string().default("gemini-2.5-flash"),

    /** Postgres (sessions, messages, memory). Default matches docker-compose.yml. */
    DATABASE_URL: z
      .string()
      .default("postgresql://sarjy:sarjy@localhost:5433/sarjy"),

    /** Redis cache for direct memory preload. Omit or leave empty to skip Redis (DB-only). */
    REDIS_URL: z.string().optional(),

    /** Summarization / memory extraction model (cheap). Defaults to main voice model. */
    VOICE_MEMORY_LLM_MODEL: z.string().optional(),

    /**
     * Per-socket journey logs under `VOICE_SESSION_JOURNEY_LOG_DIR` (latency tracing). Default on; set 0/false/off to disable.
     */
    VOICE_SESSION_JOURNEY_LOG_ENABLED: z
      .string()
      .optional()
      .transform((v) => {
        if (!v?.trim()) return true;
        return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
      }),

    /** Directory for per-session `voice-*.log` files (created if missing). Default: `<cwd>/logs/voice-sessions`. */
    VOICE_SESSION_JOURNEY_LOG_DIR: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.VOICE_LLM_PROVIDER === "openai") {
      if (!data.OPENAI_API_KEY?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "OPENAI_API_KEY is required when VOICE_LLM_PROVIDER=openai",
          path: ["OPENAI_API_KEY"],
        });
      }
    }
    if (data.VOICE_LLM_PROVIDER === "google") {
      if (!data.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "GOOGLE_GENERATIVE_AI_API_KEY is required when VOICE_LLM_PROVIDER=google",
          path: ["GOOGLE_GENERATIVE_AI_API_KEY"],
        });
      }
    }
    if (data.VOICE_LLM_PROVIDER === "groq") {
      if (!data.GROQ_API_KEY?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "GROQ_API_KEY is required when VOICE_LLM_PROVIDER=groq",
          path: ["GROQ_API_KEY"],
        });
      }
    }
    if (data.VOICE_TTS_PROVIDER === "cartesia" && !data.CARTESIA_API_KEY?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "CARTESIA_API_KEY is required when VOICE_TTS_PROVIDER=cartesia",
        path: ["CARTESIA_API_KEY"],
      });
    }
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  console.error(parsed.error.issues);
  process.exit(1);
}

export const env = parsed.data;
