# GTB

GTB is a Minecraft block guessing game. The server secretly chooses a block, the player asks up to 20 yes/no questions, and the app answers using local block facts, Minecraft Wiki context, texture analysis, and Gemini when wording needs interpretation.

## Features

- Random hidden block from the Minecraft 26.1 block list
- Shareable rounds at `/game/[id]`
- Yes/no question history with optional debug mode
- Texture-backed color answers from downloaded Minecraft Wiki texture data
- Minecraft Wiki page/table context for history and mechanics questions
- Report flow for incorrect answers
- Admin dashboard with username/password login and signed HttpOnly session cookies

## Tech Stack

- Next.js app router
- React client components
- Local JSON files for development storage
- Supabase Postgres for production storage
- Gemini API for question interpretation
- Minecraft Wiki API/cache for block context

## Setup

Copy the example environment file:

```bash
cp .env.example .env
```

Set these values:

```txt
GEMINI_API_KEY=your_google_ai_studio_key
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_FALLBACK_MODELS=gemini-2.5-flash,gemini-2.0-flash-lite
WIKI_CONTEXT=1
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
ADMIN_USERNAME=your_admin_username
ADMIN_PASSWORD=your_admin_password
ADMIN_SESSION_SECRET=a_long_random_string
PORT=3000
```

Start local development:

```bash
./start.sh
```

Open:

```txt
http://localhost:3000
```

Stop the server:

```bash
./stop.sh
```

## Admin

Open:

```txt
http://localhost:3000/admin
```

Admin login requires `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_SESSION_SECRET`. Do not deploy with a placeholder password.

## Data

Important generated files:

- `data/blocks.json`: block list imported from the official Minecraft client jar
- `data/block-textures.json`: texture/color facts generated from Minecraft Wiki textures
- `public/images/minecraft-bg.png`: site background screenshot

Development-only files are ignored by git:

- `data/games.json`
- `data/reports.json`
- `data/corrections.json`
- `data/wiki-cache/`
- `data/import-cache/`
- `public/block-textures/`

When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, games, reports, and corrections are stored in Supabase instead of local JSON files.

## Supabase

Create the database tables:

```bash
supabase db push
```

The app only uses the Supabase service-role key on the server. Do not expose `SUPABASE_SERVICE_ROLE_KEY` in browser code.

## Import Commands

Regenerate the block database:

```bash
npm run import:blocks
```

Regenerate texture color data:

```bash
npm run import:textures
```

## Deployment Notes

This project uses API routes and server-side secrets, so it cannot be hosted as-is on GitHub Pages. GitHub Pages only serves static files.

Use GitHub for source control and deploy the app to a Next.js host such as Vercel.

For production, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel so game, report, and correction data persists.

## Useful Commands

Build check:

```bash
npm run build
```

Run production build locally:

```bash
npm run build
npm run start
```
