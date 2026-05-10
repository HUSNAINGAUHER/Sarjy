# Sarjy

Voice-enabled web assistant with session persistence and weather tool grounding.

## Features

- Voice interaction (Deepgram, ElevenLabs)
- Cross-session preference memory (`sessionId` keyed storage)
- Weather tool backed by `[provider]`

## Repository structure

This is a Yarn-workspace monorepo:

```
.
├── apps/
│   ├── frontend/          # Next.js (App Router) + Tailwind + React Query
│   └── backend/           # Express + Socket.IO
└── packages/
    └── shared-types/      # @sarjy/shared-types — types shared by FE & BE
```

- **Shared contracts** live in `packages/shared-types` and are imported as `@sarjy/shared-types` from both apps.
- **Frontend-only** types live under `apps/frontend/src/types/*` and are imported as `@/types/...`.
- **Backend-only** types live under `apps/backend/src/types/*` and are imported as `@/types/...`.

## Quickstart

### Prerequisites

- Node `>=24.0.0` (see `.nvmrc`)
- Yarn `1.x` (Classic)
- API keys (see Configuration)
- **Postgres + Redis** for chat sessions and memory: `docker compose up -d` from the repo root, then `cd apps/backend && yarn db:migrate` (uses `DATABASE_URL` / `REDIS_URL` in `apps/backend/.env`; compose maps Postgres to host **5433** so it won’t conflict with another DB on 5432).

### Install

```bash
yarn install
```

### Configure

Copy environment templates:

```bash
cp apps/frontend/.env.example apps/frontend/.env.local
cp apps/backend/.env.example  apps/backend/.env
```

### Run (development)

In two terminals — backend first so the frontend's `useHealth` query has something to hit:

```bash
yarn dev:backend     # http://localhost:4000
yarn dev:frontend    # http://localhost:3000
```

### Build (production)

```bash
yarn build           # builds shared-types → backend → frontend
yarn start:backend   # node dist/index.js
yarn start:frontend  # next start
```

### Other scripts

```bash
yarn typecheck       # TS typecheck across all workspaces
yarn lint            # lint across all workspaces
yarn build:shared    # build only @sarjy/shared-types
yarn clean           # remove build artifacts and node_modules
```

## TypeScript path aliases

Each workspace has scoped `@/*` aliases that do **not** leak across apps:

| Workspace                | Alias                       | Resolves to                          |
| ------------------------ | --------------------------- | ------------------------------------ |
| `apps/frontend`          | `@/*`                       | `apps/frontend/src/*`                |
| `apps/frontend`          | `@/components/*`, `@/hooks/*`, `@/lib/*`, `@/providers/*`, `@/types/*` | scoped subpaths |
| `apps/backend`           | `@/*`                       | `apps/backend/src/*`                 |
| `apps/backend`           | `@/config/*`, `@/controllers/*`, `@/middleware/*`, `@/routes/*`, `@/services/*`, `@/sockets/*`, `@/types/*`, `@/utils/*` | scoped subpaths |
| both apps + shared       | `@sarjy/shared-types`       | `packages/shared-types/src/index.ts` |

### How aliases work at build time

- **Frontend** — Next.js / SWC reads `paths` from `tsconfig.json` natively, so no extra runtime tooling is required.
- **Backend** — In dev we use `tsx` (which respects `tsconfig.json` paths). For production builds, `tsc` emits to `dist/` and `tsc-alias` rewrites `@/*` imports to the correct relative paths. `@sarjy/shared-types` is resolved through `node_modules` (the workspace symlink), so it is not rewritten.

## Configuration

Frontend env (`apps/frontend/.env.local`):

```
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
```

Backend env (`apps/backend/.env`):

```
PORT=4000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000
```
