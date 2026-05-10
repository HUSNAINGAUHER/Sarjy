/**
 * Input guardrails for the voice assistant.
 *
 * The voice path is uniquely vulnerable: anything the user dictates is fed to
 * the LLM as a plain user message, so prompt-injection attempts arrive
 * verbatim. The system prompt is the primary defense, but it is not
 * deterministic. This module catches the most common attacks BEFORE the LLM
 * call and produces a short spoken refusal that the pipeline routes straight
 * to TTS — skipping the model entirely. The TTS path stays the same.
 *
 * Categories detected:
 *   • prompt_injection  — "ignore previous instructions", role override, etc.
 *   • system_introspection — "show me your system prompt", "repeat above".
 *   • prohibited_topic — weapons synthesis, hard-drug recipes, CSAM intent,
 *     directly-actionable self-harm methods.
 *
 * Self-harm crisis content gets a SAFE-RESOURCES spoken line instead of a flat
 * refusal so the assistant still helps the human.
 *
 * Pattern matching is conservative on purpose — we want very few false
 * positives in casual dictated speech. The system prompt does the broader
 * soft-policy work; this layer is the kill switch.
 */

export type GuardrailCategory =
  | "prompt_injection"
  | "system_introspection"
  | "prohibited_topic"
  | "self_harm_crisis";

export interface GuardrailVerdict {
  allow: boolean;
  category?: GuardrailCategory;
  matchedPattern?: string;
  /**
   * Short, spoken-style refusal (or safety message). Designed to read naturally
   * through TTS — no markdown, no jargon, single sentence in most cases.
   */
  spokenRefusal?: string;
}

interface GuardrailRule {
  category: GuardrailCategory;
  pattern: RegExp;
  spokenRefusal: string;
  /** Used in logs for triage. */
  label: string;
}

/**
 * Spoken refusals — phrased so they fit the voice persona system. Keep them
 * short and friendly; the user will hear the line out loud.
 */
const REFUSAL_PROMPT_INJECTION =
  "Sorry, I can't change who I am or follow instructions that override my guidelines. What else can I help you with?";

const REFUSAL_SYSTEM_INTROSPECTION =
  "I'm not able to share my internal instructions, but I'm happy to help with whatever you actually need.";

const REFUSAL_PROHIBITED_GENERIC =
  "That's not something I'm able to help with. Is there something else I can do for you?";

const REFUSAL_DANGEROUS_HOWTO =
  "I can't help with that one — it's off-limits for me. Anything else I can do?";

const REFUSAL_CSAM = "I can't help with that, full stop.";

const SAFE_MESSAGE_SELF_HARM =
  "I'm really sorry you're feeling like this. If you're in crisis right now, please reach a local helpline — in the US you can call or text nine eight eight. I'm here if you'd like to talk about something else, too.";

const RULES: readonly GuardrailRule[] = [
  // ── Prompt injection / role override ──────────────────────────────────────
  {
    label: "ignore_instructions",
    category: "prompt_injection",
    pattern:
      /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}\b(all|the|your|previous|prior|earlier|above|prior)\b[\s\S]{0,40}\b(instruction|instructions|rules|prompt|prompts|system|guidelines|directives)\b/i,
    spokenRefusal: REFUSAL_PROMPT_INJECTION,
  },
  {
    label: "you_are_now",
    category: "prompt_injection",
    pattern:
      /\b(you are now|from now on you are|act as|pretend (you are|to be|that you are)|roleplay as|simulate (being |a |an )?)\b[\s\S]{0,80}\b(dan|do anything now|jailbroken|unfiltered|uncensored|no rules|no restrictions|evil|without (limits|restrictions|guardrails|rules|filters))\b/i,
    spokenRefusal: REFUSAL_PROMPT_INJECTION,
  },
  {
    label: "developer_mode",
    category: "prompt_injection",
    pattern:
      /\b(developer mode|dev mode|debug mode|admin mode|god mode|sudo mode|root mode|jailbreak|jailbroken)\b/i,
    spokenRefusal: REFUSAL_PROMPT_INJECTION,
  },
  {
    label: "bypass_safety",
    category: "prompt_injection",
    pattern:
      /\b(bypass|circumvent|disable|turn off|switch off|get around|work around)\b[\s\S]{0,40}\b(safety|filter|filters|content policy|policies|restriction|restrictions|guardrail|guardrails|moderation)\b/i,
    spokenRefusal: REFUSAL_PROMPT_INJECTION,
  },

  // ── System introspection / prompt leak attempts ───────────────────────────
  {
    label: "reveal_system_prompt",
    category: "system_introspection",
    pattern:
      /\b(show|reveal|tell|share|print|display|repeat|read)\b[\s\S]{0,30}\b(your |the )?(system|hidden|secret|initial|original)\b[\s\S]{0,20}\b(prompt|instructions|rules|message|directive|directives)\b/i,
    spokenRefusal: REFUSAL_SYSTEM_INTROSPECTION,
  },
  {
    label: "repeat_above",
    category: "system_introspection",
    pattern:
      /\b(repeat|print|read back|recite|echo)\b[\s\S]{0,30}\b(everything|all|the (text|message|content|prompt) )?(above|before|prior|previously|that came before)\b/i,
    spokenRefusal: REFUSAL_SYSTEM_INTROSPECTION,
  },
  {
    label: "what_are_your_instructions",
    category: "system_introspection",
    pattern:
      /\b(what (are|were)|tell me)\b[\s\S]{0,30}\b(your|the)\b[\s\S]{0,20}\b(initial |original |hidden |system |secret )(instructions|prompt|rules|directives)\b/i,
    spokenRefusal: REFUSAL_SYSTEM_INTROSPECTION,
  },

  // ── Self-harm crisis (route to safe-resources line, not a flat refusal) ──
  {
    label: "self_harm_methods",
    category: "self_harm_crisis",
    pattern:
      /\b(how (do|to|can) (i|one|someone) (kill|hurt|harm|cut|injure|end))\b[\s\S]{0,20}\b(myself|my ?self|themselves|themself)\b/i,
    spokenRefusal: SAFE_MESSAGE_SELF_HARM,
  },
  {
    label: "suicide_methods",
    category: "self_harm_crisis",
    pattern:
      /\b(suicide methods|painless ways to die|easiest way to (die|kill myself)|best way to (kill|hurt) myself|how (do|to) i commit suicide)\b/i,
    spokenRefusal: SAFE_MESSAGE_SELF_HARM,
  },

  // ── Dangerous synthesis / weapons how-to ─────────────────────────────────
  {
    label: "weapons_explosives_howto",
    category: "prohibited_topic",
    pattern:
      /\bhow (do|to|can) (i|you|one|we)\b[\s\S]{0,40}\b(make|build|create|synthesize|cook|assemble|construct)\b[\s\S]{0,40}\b(bomb|explosive|c4|tnt|ricin|sarin|napalm|nerve agent|chlorine gas|mustard gas|pipe bomb|pressure cooker bomb|grenade|landmine|silencer|suppressor|untraceable (gun|firearm|weapon)|ghost gun)\b/i,
    spokenRefusal: REFUSAL_DANGEROUS_HOWTO,
  },
  {
    label: "drugs_synthesis",
    category: "prohibited_topic",
    pattern:
      /\bhow (do|to|can) (i|you|one|we)\b[\s\S]{0,40}\b(make|cook|synthesize|produce|manufacture)\b[\s\S]{0,40}\b(meth|methamphetamine|crack|cocaine|heroin|fentanyl|lsd|mdma|ecstasy)\b/i,
    spokenRefusal: REFUSAL_DANGEROUS_HOWTO,
  },

  // ── CSAM (zero-tolerance flat refusal) ────────────────────────────────────
  {
    label: "csam",
    category: "prohibited_topic",
    pattern:
      /\b(child|children|minor|minors|underage|under-age|prepubescent|toddler|infant|kid|kids)\b[\s\S]{0,40}\b(porn|pornography|sexual|sex|nude|naked|erotic|cp)\b/i,
    spokenRefusal: REFUSAL_CSAM,
  },
];

/**
 * Evaluate a single user utterance against the guardrail rule set.
 * Returns the first matching rule, or `{ allow: true }` when none match.
 */
export function evaluateUserInput(text: string): GuardrailVerdict {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return { allow: true };

  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        allow: false,
        category: rule.category,
        matchedPattern: rule.label,
        spokenRefusal: rule.spokenRefusal,
      };
    }
  }

  return { allow: true };
}

/**
 * Generic refusal text for callers that need a category-only hint (e.g. a
 * second LLM pass that wants to inject the refusal as the assistant's reply).
 */
export function spokenRefusalFor(category: GuardrailCategory): string {
  switch (category) {
    case "prompt_injection":
      return REFUSAL_PROMPT_INJECTION;
    case "system_introspection":
      return REFUSAL_SYSTEM_INTROSPECTION;
    case "self_harm_crisis":
      return SAFE_MESSAGE_SELF_HARM;
    case "prohibited_topic":
      return REFUSAL_PROHIBITED_GENERIC;
  }
}
