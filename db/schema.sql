-- ============================================================================
-- STRIX Snax Store - Postgres schema
-- Applied by `npm run db:setup`, which is idempotent and safe to re-run.
-- ============================================================================

-- No extensions required. Everything here is core Postgres, which keeps the
-- schema applicable by a role without superuser and avoids depending on which
-- schema a managed host installs extensions into.

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

-- When the admins were last told this line was nearly gone.
--
-- The alert fires on the crossing, not on the state: without a marker, every
-- sale of an item already down to its last two would send the same message
-- again, and a committee that gets fifteen identical alerts in an evening
-- stops reading them. Restocking clears it, so the next fall alerts again.
alter table items add column if not exists low_stock_alerted_at timestamptz;

-- Anything not held by a live order is buyable.
create or replace view items_public as
  select i.*, greatest(i.stock - i.reserved, 0) as available
  from items i;

-- ---------------------------------------------------------------------------
-- Users (Telegram identities). We never store a password - Telegram is the IdP.
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
  payment_proof_id  uuid,                          -- -> payment_proofs.id
  payment_ref       text,                          -- what the buyer typed in PayNow
  reviewed_by       uuid references app_users(id),
  reviewed_at       timestamptz,
  review_note       text,
  sheet_synced_at   timestamptz,
  expires_at        timestamptz not null default (now() + interval '45 minutes'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- When the packets actually left the shelf.
--
-- The buyer collects as soon as they have uploaded a screenshot, rather than
-- waiting for an admin, so the shelf is debited at that moment and not at
-- approval. Recording when it happened is what keeps the debit to exactly one
-- per order: a later approval, rejection or re-submission must not move stock
-- a second time, because by then the snacks are already in someone's bag.
alter table orders add column if not exists stock_spent_at timestamptz;

-- How the payment screenshot arrived. The buyer sends it to the bot in
-- Telegram, so the app records which channel it came through, and when the
-- Mini App last nudged them to send it. Both are for the humans reading the
-- order: knowing a nudge went out five minutes ago is what stops an admin
-- chasing someone who is already mid-upload.
alter table orders add column if not exists proof_source text;
alter table orders add column if not exists proof_requested_at timestamptz;

-- The last row written into the Orders tab of the spreadsheet, so a status
-- change refreshes the row it already has instead of hunting for it by code
-- on every write.
alter table orders add column if not exists sheet_row int;

create index if not exists orders_user_idx    on orders(user_id, created_at desc);
create index if not exists orders_status_idx  on orders(status, created_at desc);
create index if not exists orders_pending_idx on orders(expires_at) where status = 'awaiting_payment';
-- Drives the "still to verify" queue, which is now the admin's whole job.
create index if not exists orders_unverified_idx on orders(created_at desc)
  where status = 'pending_review';

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
-- Stock ledger - every movement is auditable
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

-- When this movement was copied into the spreadsheet's ledger tab.
--
-- The tab is append-only, so "write the rows for this order" run twice writes
-- them twice, and a shop that sold two packets appears to have sold four. The
-- stamp makes the copy a claim: a row is written exactly once, whichever of
-- the several things that move stock happens to trigger the sync.
alter table stock_movements add column if not exists sheeted_at timestamptz;

create index if not exists stock_movements_unsheeted_idx
  on stock_movements(created_at) where sheeted_at is null;

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
  ('announcement', '"We are open 24/7 - Blk B Lounge & Blk B Pantry"'::jsonb),
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

-- Forward declaration: create_order calls this, and this calls release_order,
-- so one of them has to be stubbed first. Replaced with the real body below.
create or replace function expire_stale_orders() returns int
language plpgsql as $$ begin return 0; end $$;

-- ============================================================================
-- create_order - the only way an order may be born.
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

  -- Release abandoned checkouts before counting stock. A long-running host
  -- also sweeps on a timer, but doing it here means the shelf is correct at
  -- the only moment it matters - someone trying to buy - even on a serverless
  -- host with no background process at all.
  perform expire_stale_orders();

  -- Cap concurrent unpaid orders so nobody can pin the whole shelf as "reserved".
  select count(*) into v_count
  from orders
  where user_id = p_user_id
    and status in ('awaiting_payment', 'pending_review');
  if v_count >= 3 then
    raise exception 'TOO_MANY_OPEN_ORDERS' using errcode = 'P0001';
  end if;

  -- Built from gen_random_uuid(), which is core Postgres, rather than
  -- pgcrypto's gen_random_bytes(). Managed hosts install extensions into their
  -- own schema - Supabase uses `extensions` - and this function pins
  -- search_path to public, so a pgcrypto call resolves on a plain database and
  -- then fails in production on the first order anyone tries to place.
  v_code := 'SNX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));

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
-- settle_order_stock - the packets have physically left the shelf.
--
-- Turns the order's reservation into a real deduction and writes the ledger.
-- Called when the buyer uploads their screenshot, because that is when they
-- walk off with the snacks; an admin verifying the payment hours later is a
-- bookkeeping step, not a stock movement.
--
-- Idempotent on stock_spent_at, so approval, rejection and re-submission can
-- all call it without the shelf being debited twice.
-- ============================================================================
create or replace function settle_order_stock(p_order_id uuid, p_actor_id uuid default null)
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

  if v_order.stock_spent_at is not null then
    return v_order;
  end if;

  for v_row in select * from order_items where order_id = p_order_id
  loop
    update items
       set stock    = greatest(stock - v_row.quantity, 0),
           reserved = greatest(reserved - v_row.quantity, 0)
     where id = v_row.item_id
    returning stock into v_bal;

    insert into stock_movements(item_id, delta, balance_after, reason, order_id, actor_id)
    values (v_row.item_id, -v_row.quantity, v_bal, 'order_paid', p_order_id, p_actor_id);
  end loop;

  update orders set stock_spent_at = now() where id = p_order_id returning * into v_order;
  return v_order;
end $$;

-- ============================================================================
-- approve_order - admin verified the PayNow screenshot.
--
-- By now the buyer has usually collected already, so this normally moves no
-- stock at all. It still settles as a fallback: an admin can approve an order
-- that never got a screenshot (someone paid in cash), and that order's
-- reservation has to become a deduction somewhere.
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

  perform settle_order_stock(p_order_id, p_admin_id);

  update orders
     set status = 'paid', reviewed_by = p_admin_id, reviewed_at = now(), review_note = p_note
   where id = p_order_id
  returning * into v_order;

  update app_users set orders_count = orders_count + 1 where id = v_order.user_id;

  return v_order;
end $$;

-- ============================================================================
-- release_order - reject / cancel / expire.
--
-- Puts a hold back on the shelf, but only a hold. Once an order's stock has
-- been spent the buyer has physically taken the snacks, so rejecting their
-- screenshot cannot restore anything - it records that the order was never
-- paid for. Crediting the shelf there would invent stock that is not on it.
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

  if v_order.stock_spent_at is null then
    for v_row in select * from order_items where order_id = p_order_id
    loop
      update items set reserved = greatest(reserved - v_row.quantity, 0)
       where id = v_row.item_id
      returning stock into v_bal;

      insert into stock_movements(item_id, delta, balance_after, reason, order_id, actor_id, note)
      values (v_row.item_id, 0, v_bal, 'order_released', p_order_id, p_admin_id, p_note);
    end loop;
  end if;

  update orders
     set status = p_status, reviewed_by = p_admin_id, reviewed_at = now(), review_note = p_note
   where id = p_order_id
  returning * into v_order;

  return v_order;
end $$;

-- ============================================================================
-- rehold_order_stock - a rejected order is being re-submitted.
--
-- release_order put this order's stock back on the shelf when it was rejected,
-- so the buyer's second screenshot has to take it off again. Without this the
-- order sits in the review queue holding nothing, and approving it deducts
-- stock that was meanwhile sold to somebody else.
--
-- Availability is re-checked under the same row lock create_order uses, so a
-- re-submission behaves exactly like a fresh order and fails the same way when
-- the shelf has emptied in the meantime.
-- ============================================================================
create or replace function rehold_order_stock(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders;
  v_row   record;
  v_item  items;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001'; end if;

  -- Only a released order needs re-holding: one still awaiting payment, or
  -- already in review, never gave its stock up.
  if v_order.status <> 'rejected' then
    return v_order;
  end if;

  -- Nor does one whose snacks are already gone. Rejecting that order returned
  -- nothing to the shelf, so a second screenshot has nothing to take back off
  -- it - re-holding here would reserve stock the buyer already walked out with.
  if v_order.stock_spent_at is not null then
    return v_order;
  end if;

  for v_row in select * from order_items where order_id = p_order_id
  loop
    select * into v_item from items where id = v_row.item_id for update;

    if not found then
      raise exception 'ITEM_NOT_FOUND:%', v_row.name using errcode = 'P0001';
    end if;
    if not v_item.is_active then
      raise exception 'ITEM_INACTIVE:%', v_item.name using errcode = 'P0001';
    end if;
    if (v_item.stock - v_item.reserved) < v_row.quantity then
      raise exception 'OUT_OF_STOCK:%:%', v_item.name, greatest(v_item.stock - v_item.reserved, 0)
        using errcode = 'P0001';
    end if;

    update items set reserved = reserved + v_row.quantity where id = v_item.id;
  end loop;

  return v_order;
end $$;


-- ============================================================================
-- adjust_stock - admin stock-take. Always writes a ledger row.
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
-- expire_stale_orders - call from the bot's janitor loop or a Supabase cron.
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
    perform release_order(v_id, null, 'cancelled', 'Expired - no payment received in time');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ============================================================================
-- Payment screenshots.
--
-- These live in the database rather than an object store so the deployment
-- needs nothing but Postgres. They are never public: an admin fetches one
-- through an authenticated route that streams the bytes back, so there is no
-- guessable URL to leak. `prune_old_proofs` keeps the table from growing
-- without bound on a small disk.
-- ============================================================================
create table if not exists payment_proofs (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  mime_type    text not null check (mime_type in ('image/jpeg','image/png','image/webp','image/heic')),
  byte_size    int  not null check (byte_size > 0 and byte_size <= 10485760),
  bytes        bytea not null,
  uploaded_by  uuid references app_users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists payment_proofs_order_idx on payment_proofs(order_id, created_at desc);

do $$ begin
  alter table orders
    add constraint orders_proof_fk
    foreign key (payment_proof_id) references payment_proofs(id) on delete set null;
exception when duplicate_object then null; end $$;

/**
 * Delete screenshots for orders settled more than `p_days` ago. The order row
 * and its receipt stay; only the image goes. Run from the janitor.
 */
create or replace function prune_old_proofs(p_days int default 60) returns int
language plpgsql
as $$
declare v_n int;
begin
  with gone as (
    delete from payment_proofs p
    using orders o
    where p.order_id = o.id
      and o.status in ('paid','collected','rejected','cancelled')
      and o.reviewed_at is not null
      and o.reviewed_at < now() - make_interval(days => p_days)
    returning p.id
  )
  select count(*) into v_n from gone;
  return v_n;
end $$;
