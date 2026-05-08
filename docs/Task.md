
# It looks like you’re interested in working at Sarj!”
## 📓Overview

We are going to build, deploy and present “Sarjy” - a voice assistant. 
### 🪜What to build 

**The minimum bar:** this is the floor, not the goal. Once it works end-to-end, stop and move to the deep-dive. That's where we learn about you. Scoping this sensibly is part of what we're evaluating, so don't pad it.

A working voice assistant that:

- Listens and responds by voice: Use whatever voice layer you want, the browser's web speech API is fine. We are not evaluating you on audio plumbing unless you choose the Latency deepdive below.
- Remembers things across sessions: "What's my favorite color?" should work if you told it earlier.
- Calls at least one external API that makes the assistant genuinely more useful: Weather, calendar, maps, transit, whatever. In your writeup, justify the choice in 2 - 3 sentences. Why this API, why this use case.



### Deploy

The chatbot should be accessible via the web and accessible to try.

- Present
- Prepare a 5 minute presentation to present to the entire Sarj team (we will wind down 30 seconds after 5 minutes)

We recommend sharing a short loom / easily accessible PDF before the meeting so the team can check out what you’ve built beforehand and can focus on asking you questions.

### 📍The Deep Dive 

Pick one of the following and go deep. One done well is better than three done shallowly. We will ask you about it in the presentation.

- **Latency:** Get time-to-first-audio as low as you can. Measure it. Tell us where the time goes, what you tried, what worked, what didn't, and what you'd do next with another week.
- **UI/UX & Multimodal**: Give Sarjy a rich frontend. This could be a 3D/video avatar, live-transcribing captions with word-level highlighting, or the ability for Sarjy to "see" images uploaded in the chat while talking. [P0]
- **Guardrails and Reliability:** Implement strict conversational guardrails. Prevent Sarjy from discussing prohibited topics, being jailbroken, or hallucinating data when using external tools.
- **Multistep workflows:** Pick one structured flow. Symptom intake, a personality test, a booking flow, whatever and make Sarjy handle it reliably. How do you keep state? How do you recover when the user goes off-script?
- Something else you're excited about. It could be telephony, bilingual support, video avatars, multimodal, MCP integrations, cost modeling. If one of those (or something we didn't list) is what you actually want to build, do that. Tell us why.

We don't expect production quality on the deep dive. We expect you to have wrestled with it and show us what you are capable of.