create table if not exists public.games (
  id text primary key,
  hidden_block_id text not null,
  status text not null check (status in ('playing', 'won', 'lost')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  questions jsonb not null default '[]'::jsonb,
  guesses jsonb not null default '[]'::jsonb
);

create index if not exists games_created_at_idx on public.games (created_at desc);

create table if not exists public.reports (
  id text primary key,
  status text not null check (status in ('pending', 'approved', 'denied')),
  game_id text not null,
  block_id text not null,
  question_id text not null,
  question text not null,
  ai_answer text not null check (ai_answer in ('yes', 'no', 'unknown')),
  suggested_answer text not null check (suggested_answer in ('yes', 'no', 'unknown')),
  explanation text not null default '',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);

create index if not exists reports_status_created_at_idx on public.reports (status, created_at desc);
create index if not exists reports_game_id_idx on public.reports (game_id);

create table if not exists public.corrections (
  id text primary key,
  block_id text not null,
  question text not null,
  answer text not null check (answer in ('yes', 'no', 'unknown')),
  explanation text not null default '',
  source_report_id text,
  created_by text not null default 'admin',
  created_at timestamptz not null default now()
);

create index if not exists corrections_block_id_created_at_idx on public.corrections (block_id, created_at desc);

alter table public.games enable row level security;
alter table public.reports enable row level security;
alter table public.corrections enable row level security;
