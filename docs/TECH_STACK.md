# Tech stack & orchestration

This document records the primary libraries, services, and the assistant orchestration approach used by Sarjy.

## Application stack

| Layer    | Choice                     | Notes                                        |
| -------- | -------------------------- | -------------------------------------------- |
| Language | TypeScript                 | Shared types across/server                   |
| Frontend | Next.js                    | App UI                                       |
| Backend  | Node JS                    |                                              |
| Repo Structure         | Monorepo : Yarn Workspaces | shared utils/types                           |
| Hosting  | Vercel / Heroku            | Public URL + environment variable management |

## Voice services (Deepgram)

### Speech-to-text (STT)

- **Service:** Deepgram
- **SDK:** `@deepgram/sdk` (server-side) or REST | Next API Router
- **Secret handling:** `DEEPGRAM_API_KEY` server-only

### Text-to-speech (TTS)

- **Service:** Deepgram TTS (e.g., Aura), ElevensLabs TTS

## LLM inference

### Provider

Primary provider: **[Google Gemini | SambaNova]**  
Rationale: **Using Model that has hight throughput and TTFT**

### Environment

- `GEMINI_API_KEY`

## Assistant orchestration (“agent”)

Sarjy uses a **tool-calling loop**, not a separate third-party agent product requirement.

### Here will be creating agents with two appraoched
1. **Custom Loop** for voice assistant with bare minimum tools (real time taking turns)
2. **Vercel AI SDK** for backend tasks

## External API: weather

- Client library: usually `fetch`
- Key: `WEATHER_API_KEY`
- Response handling: strict JSON parsing; surface errors to the model as tool error text

## Persistence

**Options**
- Postgress 
- Flat File Storage (Simplitcity)
- Redis

Others (`[FileBase , Postgres (Neon/Supabase) , Drizzle/Prisma | SQLite/Turso]` )
**Selected store:**
-  Maybe File Base or Postgress with Redis Cache

**Reason:** `TODO`

## User Management
- Manage Users by Name, for simplicity no passwords, Browser show existing name that are previously opened or new name, Should be unique
- Sessions will be maintained against username, user should be able to talk in previous sessions

Minimum schema concepts:

- `sessions` (optional if only using KV facts)
- `messages` (optional)
- `user_facts` (`session_id`, `key`, `value`, `updated_at`)

## Supporting libraries (typical)

| Concern           | Library                              |
| ----------------- | ------------------------------------ |
| Schema validation | `zod`                                |
| HTTP              | `axios`                              |
| Styling           | Tailwind CSS                         |
| Communication - Real Time Chat | Socket io | 
| REST | Express Node JS |

## Local development requirements

- Node.js version: `24.0.0`
- Package manager: `[yarn]`
