-- ============================================================================
-- STRIX Snax Store — Supabase schema
-- Run this once in the Supabase SQL editor (or `supabase db push`).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type order_status as enum (
    'awaiting_payment',   -- created, waiting for the buyer to pay + upload proof
    'pending_review',     -- proof uploaded, waiting for an admin
    'paid',               -- admin verified the payment
    'rejected',           -- admin rejected the proof
    'cancelled',          -- buyer or system cancelled / expired
    'collected'           -- buyer picked the order up
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type stock_reason as enum (
    'restock', 'manual_adjust', 'order_paid', 'order_released', 'spoilage', 'correction'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Categories  (Snax = Blk B Lounge, Drinks = Blk B Pantry)
-- ---------------------------------------------------------------------------
create table if not exists categories (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  kind          text not null check (kind in ('snack', 'drink')),
  collection_point text not null,
  tagline       text,
  accent        text not null default 'blue' check (accent in ('blue','red','navy','gold','sky')),
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------
create table if not exists items (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references categories(id) on delete restrict,
  sku           text not null unique,
  name          text not null,
  variant       text,                       -- e.g. "Almond", "Tom Yam Seafood"
  description   text,
  -- price stored in CENTS so we never do float maths on money
  price_cents   int  not null check (price_cents >= 0),
  emoji         text,
  image_url     text,
  is_special    boolean not null default false,
  is_top_pick   boolean not null default false,
  is_active     boolean not null default true,
  stock         int  not null default 0 check (stock >= 0),
  reserved      int  not null default 0 check (reserved >= 0),
  low_stock_at  int  not null default 5,
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists items_category_idx on items(category_id);
create index if not exists items_active_idx   on items(is_active) where is_active;

-- Anything not held by a live order is buyable.
create or replace view items_public as
  select i.*, greatest(i.stock - i.reserved, 0) as available
  from items i;

-- ---------------------------------------------------------------------------
-- Users (Telegram identities). We never store a password — Telegram is the IdP.
-- ---------------------------------------------------------------------------
create table if not exists app_users (
  id             uuid primary key default gen_random_uuid(),
  telegram_id    bigint not null unique,
  username       text,
  first_name     text,
  last_name      text,
  photo_url      text,
  display_name   text,                       -- name typed at checkout, reused next time
  is_admin       boolean not null default false,
  is_blocked     boolean not null default false,
  orders_count   int not null default 0,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

create index if not exists app_users_admin_idx on app_users(is_admin) where is_admin;

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
create table if not exists orders (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,          -- human ref, e.g. SNX-7F3K2
  user_id           uuid not null references app_users(id) on delete restrict,
  telegram_id       bigint not null,
  buyer_name        text not null,
  status            order_status not null default 'awaiting_payment',
  subtotal_cents    int  not null check (subtotal_cents >= 0),
  total_cents       int  not null check (total_cents >= 0),
  collection_points text[] not null default '{}',
  note              text,
  payment_proof_path text,                         -- private storage object path
  payment_ref       text,                          -- what the buyer typed in PayNow
  reviewed_by       uuid references app_users(id),
  reviewed_at       timestamptz,
  review_note       text,
  sheet_synced_at   timestamptz,
  expires_at        timestamptz not null default (now() + interval '45 minutes'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists orders_user_idx    on orders(user_id, created_at desc);
create index if not exists orders_status_idx  on orders(status, created_at desc);
create index if not exists orders_pending_idx on orders(expires_at) where status = 'awaiting_payment';

create table if not exists order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  item_id       uuid not null references items(id) on delete restrict,
  -- denormalised so the receipt survives later price/name edits
  sku           text not null,
  name          text not null,
  variant       text,
  unit_price_cents int not null check (unit_price_cents >= 0),
  quantity      int not null check (quantity > 0 and quantity <= 99),
  line_total_cents int not null check (line_total_cents >= 0),
  created_at    timestamptz not null default now()
);

create index if not exists order_items_order_idx on order_items(order_id);

-- ---------------------------------------------------------------------------
-- Stock ledger — every movement is auditable
-- ---------------------------------------------------------------------------
create table if not exists stock_movements (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references items(id) on delete cascade,
  delta        int not null,
  balance_after int not null,
  reason       stock_reason not null,
  order_id     uuid references orders(id) on delete set null,
  actor_id     uuid references app_users(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists stock_movements_item_idx on stock_movements(item_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Key/value store settings
-- ---------------------------------------------------------------------------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into settings(key, value) values
  ('store_open',   'true'::jsonb),
  ('announcement', '"We are open 24/7 — Blk B Lounge & Blk B Pantry"'::jsonb),
  -- How long an unpaid order holds its stock before the janitor releases it.
  ('order_expiry_minutes', '45'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists items_touch  on items;
create trigger items_touch  before update on items  for each row execute function touch_updated_at();
drop trigger if exists orders_touch on orders;
create trigger orders_touch before update on orders for each row execute function touch_updated_at();

-- ============================================================================
-- create_order — the only way an order may be born.
-- Prices and stock are read from the table under a row lock, so a client can
-- never dictate a price and two shoppers can never buy the same last packet.
-- ============================================================================
create or replace function create_order(
  p_user_id    uuid,
  p_telegram_id bigint,
  p_buyer_name text,
  p_note       text,
  p_items      jsonb          -- [{ "item_id": uuid, "quantity": int }, ...]
) returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order        orders;
  v_code         text;
  v_line         jsonb;
  v_item         items;
  v_qty          int;
  v_subtotal     int := 0;
  v_line_total   int;
  v_points       text[] := '{}';
  v_point        text;
  v_count        int;
  v_expiry_min   int;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_items) > 40 then
    raise exception 'CART_TOO_LARGE' using errcode = 'P0001';
  end if;

  if coalesce((select value::text from settings where key = 'store_open'), 'true') = 'false' then
    raise exception 'STORE_CLOSED' using errcode = 'P0001';
  end if;

  -- Cap concurrent unpaid orders so nobody can pin the whole shelf as "reserved".
  select count(*) into v_count
  from orders
  where user_id = p_user_id
    and status in ('awaiting_payment', 'pending_review');
  if v_count >= 3 then
    raise exception 'TOO_MANY_OPEN_ORDERS' using errcode = 'P0001';
  end if;

  v_code := 'SNX-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 5));

  select coalesce((value #>> '{}')::int, 45) into v_expiry_min
  from settings where key = 'order_expiry_minutes';
  v_expiry_min := coalesce(v_expiry_min, 45);

  insert into orders(code, user_id, telegram_id, buyer_name, note,
                     subtotal_cents, total_cents, expires_at)
  values (v_code, p_user_id, p_telegram_id, p_buyer_name, nullif(trim(p_note), ''),
          0, 0, now() + make_interval(mins => v_expiry_min))
  returning * into v_order;

  for v_line in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_line->>'quantity')::int;
    if v_qty is null or v_qty < 1 or v_qty > 99 then
      raise exception 'BAD_QUANTITY' using errcode = 'P0001';
    end if;

    -- Lock the row: concurrent checkouts queue up here instead of racing.
    select * into v_item
    from items
    where id = (v_line->>'item_id')::uuid
    for update;

    if not found then
      raise exception 'ITEM_NOT_FOUND:%', v_line->>'item_id' using errcode = 'P0001';
    end if;
    if not v_item.is_active then
      raise exception 'ITEM_INACTIVE:%', v_item.name using errcode = 'P0001';
    end if;
    if (v_item.stock - v_item.reserved) < v_qty then
      raise exception 'OUT_OF_STOCK:%:%', v_item.name, greatest(v_item.stock - v_item.reserved, 0)
        using errcode = 'P0001';
    end if;

    v_line_total := v_item.price_cents * v_qty;
    v_subtotal   := v_subtotal + v_line_total;

    insert into order_items(order_id, item_id, sku, name, variant,
                            unit_price_cents, quantity, line_total_cents)
    values (v_order.id, v_item.id, v_item.sku, v_item.name, v_item.variant,
            v_item.price_cents, v_qty, v_line_total);

    -- Hold the stock without spending it yet.
    update items set reserved = reserved + v_qty where id = v_item.id;

    select collection_point into v_point from categories where id = v_item.category_id;
    if v_point is not null and not (v_point = any(v_points)) then
      v_points := array_append(v_points, v_point);
    end if;
  end loop;

  update orders
     set subtotal_cents = v_subtotal,
         total_cents    = v_subtotal,
         collection_points = v_points
   where id = v_order.id
  returning * into v_order;

  return v_order;
end $$;

-- ============================================================================
-- approve_order — admin verified the PayNow screenshot.
-- Converts the reservation into a real stock deduction and logs the ledger.
-- ============================================================================
create or replace function approve_order(p_order_id uuid, p_admin_id uuid, p_note text default null)
returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders;
  v_row   record;
  v_bal   int;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_order.status = 'paid' or v_order.status = 'collected' then
    return v_order;                                   -- idempotent: double-tap is harmless
  end if;
  if v_order.status not in ('awaiting_payment', 'pending_review') then
    raise exception 'ORDER_NOT_REVIEWABLE:%', v_order.status using errcode = 'P0001';
  end if;

  for v_row in select * from order_items where order_id = p_order_id
  loop
    update items
       set stock    = greatest(stock - v_row.quantity, 0),
           reserved = greatest(reserved - v_row.quantity, 0)
     where id = v_row.item_id
    returning stock into v_bal;

    insert into stock_movements(item_id, delta, balance_after, reason, order_id, actor_id)
    values (v_row.item_id, -v_row.quantity, v_bal, 'order_paid', p_order_id, p_admin_id);
  end loop;

  update orders
     set status = 'paid', reviewed_by = p_admin_id, reviewed_at = now(), review_note = p_note
   where id = p_order_id
  returning * into v_order;

  update app_users set orders_count = orders_count + 1 where id = v_order.user_id;

  return v_order;
end $$;

-- ============================================================================
-- release_order — reject / cancel / expire. Puts the held stock back.
-- ============================================================================
create or replace function release_order(
  p_order_id uuid,
  p_admin_id uuid,
  p_status   order_status,
  p_note     text default null
) returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders;
  v_row   record;
  v_bal   int;
begin
  if p_status not in ('rejected', 'cancelled') then
    raise exception 'BAD_RELEASE_STATUS' using errcode = 'P0001';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_order.status in ('rejected', 'cancelled') then
    return v_order;                                   -- idempotent
  end if;
  if v_order.status in ('paid', 'collected') then
    raise exception 'ORDER_ALREADY_PAID' using errcode = 'P0001';
  end if;

  for v_row in select * from order_items where order_id = p_order_id
  loop
    update items set reserved = greatest(reserved - v_row.quantity, 0)
     where id = v_row.item_id
    returning stock into v_bal;

    insert into stock_movements(item_id, delta, balance_after, reason, order_id, actor_id, note)
    values (v_row.item_id, 0, v_bal, 'order_released', p_order_id, p_admin_id, p_note);
  end loop;

  update orders
     set status = p_status, reviewed_by = p_admin_id, reviewed_at = now(), review_note = p_note
   where id = p_order_id
  returning * into v_order;

  return v_order;
end $$;

-- ============================================================================
-- adjust_stock — admin stock-take. Always writes a ledger row.
-- ============================================================================
create or replace function adjust_stock(
  p_item_id uuid,
  p_admin_id uuid,
  p_delta   int,
  p_reason  stock_reason default 'manual_adjust',
  p_note    text default null
) returns items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item items;
begin
  update items set stock = greatest(stock + p_delta, 0) where id = p_item_id returning * into v_item;
  if not found then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0001'; end if;

  insert into stock_movements(item_id, delta, balance_after, reason, actor_id, note)
  values (p_item_id, p_delta, v_item.stock, p_reason, p_admin_id, p_note);

  return v_item;
end $$;

-- Set an absolute count (what a stock-take actually produces) and log the delta.
create or replace function set_stock(
  p_item_id uuid,
  p_admin_id uuid,
  p_count   int,
  p_note    text default null
) returns items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item items;
  v_delta int;
begin
  select * into v_item from items where id = p_item_id for update;
  if not found then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_count < 0 then raise exception 'NEGATIVE_STOCK' using errcode = 'P0001'; end if;

  v_delta := p_count - v_item.stock;
  update items set stock = p_count where id = p_item_id returning * into v_item;

  insert into stock_movements(item_id, delta, balance_after, reason, actor_id, note)
  values (p_item_id, v_delta, p_count, 'correction', p_admin_id, p_note);

  return v_item;
end $$;

-- ============================================================================
-- expire_stale_orders — call from the bot's janitor loop or a Supabase cron.
-- ============================================================================
create or replace function expire_stale_orders() returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  for v_id in
    select id from orders
    where status = 'awaiting_payment' and expires_at < now()
    limit 100
  loop
    perform release_order(v_id, null, 'cancelled', 'Expired — no payment received in time');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ============================================================================
-- Row Level Security.
-- The API talks to Postgres with the service_role key from the server only;
-- the anon key is never shipped to the Mini App. RLS is belt-and-braces so a
-- leaked anon key still reads nothing but the public menu.
-- ============================================================================
alter table categories      enable row level security;
alter table items           enable row level security;
alter table app_users       enable row level security;
alter table orders          enable row level security;
alter table order_items     enable row level security;
alter table stock_movements enable row level security;
alter table settings        enable row level security;

drop policy if exists categories_read on categories;
create policy categories_read on categories for select using (true);

drop policy if exists items_read on items;
create policy items_read on items for select using (is_active);

-- No anon policy at all on the rest => anon sees nothing.
-- service_role bypasses RLS, which is what the API server uses.

-- ---------------------------------------------------------------------------
-- Private bucket for PayNow screenshots. Admins read them through short-lived
-- signed URLs minted server-side; the bucket itself is never public.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
