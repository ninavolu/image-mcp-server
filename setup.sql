-- Run this in your Supabase SQL editor

create table if not exists images (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  file_path text not null,
  purpose text not null,         -- e.g. 'landing-page', 'document', 'hero', 'thumbnail', 'icon', 'background'
  tags text[] default '{}',      -- e.g. '{dark, minimal, product}'
  description text,
  created_at timestamptz default now()
);

-- Index for fast purpose + tag lookups
create index if not exists images_purpose_idx on images(purpose);
create index if not exists images_tags_idx on images using gin(tags);
