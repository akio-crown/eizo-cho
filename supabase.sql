-- 映像記憶帳の同期用テーブル。Supabase の SQL Editor に貼って Run するだけ。
create table if not exists vk_items (
  id         text primary key,
  data       jsonb not null,
  updated    bigint not null,                      -- 端末側の更新時刻（どちらが新しいかの判定）
  server_ts  timestamptz not null default now()    -- サーバー側の時刻（取りこぼし防止の目印）
);

create or replace function vk_touch() returns trigger language plpgsql as $$
begin
  new.server_ts := clock_timestamp();
  return new;
end $$;

drop trigger if exists vk_touch on vk_items;
create trigger vk_touch before insert or update on vk_items
  for each row execute function vk_touch();

create index if not exists vk_items_server_ts on vk_items (server_ts);

-- 個人用：キーを知っている端末だけが読み書きする前提。
-- （URL とキーはアプリの設定画面に入れるだけで、公開するコードには含めない）
alter table vk_items enable row level security;
drop policy if exists vk_all on vk_items;
create policy vk_all on vk_items for all to anon using (true) with check (true);
