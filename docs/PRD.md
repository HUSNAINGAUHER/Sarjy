# PRD: Sarjy — Voice-First Personal Assistant (MVP) - Bare Minimum

## 1. Document Info
- **Status:** Draft for implementation

---

## 2. Product Vision

Sarjy is a voice-first web assistant that helps users get quick, useful answers in a natural conversational flow while retaining important personal preferences over time.  
The MVP focuses on reliability, clarity, and trust: users should be able to speak, get useful responses, and feel that Sarjy remembers them.

---

## 3. Problem & Opportunity

Current assistant experiences often break in three places:
1. Conversation feels mechanical due to weak voice interaction.
2. User context is lost between sessions.
3. Responses are generic because no real-world tools are connected.

The MVP addresses these gaps by combining voice interaction, persistent user memory, and one high-utility external data integration.

---

## 4. Goals

### Primary Goals
- Deliver a working voice-based assistant on web.
- Persist key user preferences across sessions.
- Provide at least one utility feature backed by external live data.
- Ship a stable, testable public deployment.

### Success Criteria
- Users can complete a full speak → respond cycle without friction.
- Stored preferences are correctly recalled in later sessions.
- Tool-backed responses are accurate and clearly grounded in external data.
- The product can be demoed end-to-end without manual intervention.

---

## 5. Advance Goals

- Advanced multimodal experiences (image/video understanding)
- Complex multi-step transactional workflows
- Extensive policy/guardrail frameworks beyond basic safety checks
- Large-scale production hardening (autoscaling, enterprise auth, etc.)
- Deep performance optimization tracks (to be addressed in future iterations)

---

## 6. Target Users & Core Jobs

### Target User
A general user who wants a quick, conversational assistant for everyday information and lightweight personalization.

### Core Jobs to Be Done
- Ask questions hands-free and receive spoken responses.
- Save and recall personal preferences (e.g., favorite color, preferred city).
- Get useful real-time information (e.g., weather) during conversation.

---

## 7. User Experience Principles

- **Low Friction:** Start speaking quickly, minimal setup.
- **Transparent:** Show transcript and tool-sourced answers clearly.
- **Trustworthy:** Avoid fabricated facts when tools fail.
- **Consistent:** Behave predictably across repeated interactions.
- **Graceful Failure:** If any component fails, user still gets a helpful response.

---

## 8. Feature Scope

## 8.1 Bare Minimum (Must Ship)

### A) Voice Interaction
- Capture user speech from browser microphone.
- Convert speech to text (STT).
- Generate assistant response via LLM.
- Convert response to audio (TTS) and play to user.
- Display text transcript of user + assistant turns.

### B) Persistent Memory
- Store durable user profile facts (e.g., preferences).
- Retrieve those facts in future sessions.
- Support explicit updates when user changes a preference.

### C) External Utility Integration
- Integrate one external API that provides clear user value.
- Recommended initial integration: weather data.
- Ensure API results are reflected accurately in assistant response.

### D) Web Deployment
- Publicly accessible URL.
- Basic onboarding instructions (how to talk, sample prompts).

---

## 8.2 Advanced (Optional, Time-Permitting)
- Memory quality improvements (confidence tagging, source tracking)
- Better fallback messaging and error categorization
- Lightweight conversation analytics for debugging
- Optional semantic recall layer for long-form conversation history


---

## 9. Functional Requirements

### FR-01 Voice Input
The system must accept microphone input and convert user speech to text.

### FR-02 Voice Output
The system must generate and play spoken assistant responses.

### FR-03 Conversational Turn Handling
The system must process turn-by-turn exchanges and maintain coherent short-term context during an active session.

### FR-04 Cross-Session Memory
The system must persist user facts and retrieve them in later sessions.

### FR-05 Memory Update Behavior
When users explicitly revise stored preferences, the latest explicit preference must be returned in future answers.

### FR-06 Tool Invocation
The system must call at least one external data source and return grounded responses from that data.

### FR-07 Tool Failure Handling
If external data retrieval fails, the system must return a clear fallback response without presenting unverified information as fact.

### FR-08 Transcript Visibility
The interface must display textual transcript for usability and debugging.

### FR-09 Deployment Availability
The product must be accessible via shareable web URL.

---

## 10. Non-Functional Requirements

- **Responsiveness:** Conversational flow should feel near-real-time for typical usage.
- **Reliability:** Core flows should not crash on malformed input or API errors.
- **Usability:** UI should clearly communicate listening/speaking states.
- **Maintainability:** Components should be modular (voice, orchestration, memory, tooling).
- **Basic Privacy:** Store only necessary user memory fields; avoid unnecessary sensitive data.

---

## 11. Product Architecture (MVP)

### Components
1. **Frontend Web Client**
   - Mic controls
   - Transcript view
   - Audio playback
   - Basic state indicators (listening/processing/responding)

2. **Assistant Backend**
   - STT/TTS orchestration
   - LLM prompt + response generation
   - External API tool execution
   - Memory extraction and retrieval pipeline

3. **Data Layer**
   - Session context store (short-term)
   - Persistent user memory store (long-term)

### Memory Model (MVP)
- **Session Context:** recent turns for immediate coherence
- **User Profile Memory:** structured facts with:
  - key
  - value
  - updated_at
  - optional confidence/source metadata

---

## 12. External API Strategy

### Initial Tool Choice: Weather
Weather is selected for MVP due to:
- high everyday utility in conversation,
- straightforward integration and validation,
- low implementation risk relative to more auth-heavy APIs.

### Other Tools: To Be Decided

### Tooling Principles
- Use tool output as source-of-truth for tool-backed answers.
- If data is unavailable, communicate uncertainty/failure explicitly.
- Keep tool interaction traceable in logs for debugging.

---

## 13. Key User Flows

### Flow 1: First-Time Preference Capture
1. User says: “My favorite color is blue.”
2. System acknowledges and stores preference.
3. User receives spoken confirmation.

### Flow 2: Cross-Session Recall
1. In a later session, user asks: “What’s my favorite color?”
2. System retrieves stored value.
3. Assistant responds with previously saved preference.

### Flow 3: Utility Query
1. User asks: “What’s the weather in Lahore?”
2. System calls weather API.
3. Assistant returns grounded weather response by voice + transcript.

### Flow 4: Tool Failure
1. User asks weather question.
2. API request fails/timeouts.
3. Assistant explains temporary issue and offers retry/helpful fallback.

---

## 14. Metrics & KPIs (MVP)

### Product KPIs
- Preference recall success rate
- Tool call success rate
- End-to-end conversation completion rate

### Experience KPIs
- Median response time per turn
- Drop-off rate after first interaction
- Error rate per 100 turns

### Quality KPIs
- Hallucination rate in tool-backed answers (target: near zero)
- Incorrect memory retrieval incidents

---

## 15. Risks & Mitigations

1. **Speech recognition errors**
   - Mitigation: transcript visibility + confirmation phrasing for memory writes

2. **Memory overwrite ambiguity**
   - Mitigation: latest explicit user statement wins, timestamped entries

3. **External API instability**
   - Mitigation: timeout, retry policy, fallback response path

4. **Conversation latency spikes**
   - Mitigation: concise response strategy, efficient orchestration, logging

5. **Demo fragility**
   - Mitigation: deterministic prompt set + backup walkthrough recording

---

## 16. Rollout Plan

### Phase 1 — Core Build
- Voice loop + transcript
- Persistent memory foundation
- One external API integration

### Phase 2 — Stabilization
- Error handling
- Logging and reliability checks
- UX polishing for state clarity
ackaging


### Phase 3 — Deep Dive
- Advance Feature & Improvements

---

## 17. Open Product Decisions

- Preferred voice stack for MVP (browser-native vs provider-based)
- Memory write confirmation strictness (always confirm vs selective confirm)
- Whether to include optional semantic memory in MVP or defer
- Deployment platform choice based on speed and familiarity

---

## 18. Future Roadmap (Post-MVP)

- Structured guardrails and policy framework
- Rich multimodal interactions
- Multi-step workflow orchestration
- Improved memory intelligence (hybrid profile + semantic episodic recall)
- Cost/performance optimization by model routing

---

## 19. Scope Commitment

For this release, the team will prioritize:
1. Bare minimum functionality with high reliability,
2. clear architectural foundations for future expansion,
3. stable deployment and demo readiness over feature breadth.
