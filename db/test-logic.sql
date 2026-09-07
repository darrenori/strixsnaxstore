-- ============================================================================
-- STRIX Snax Store — business-logic assertions
--
-- Run against a scratch database that already has schema.sql + seed.sql:
--
--   psql -d strix -v ON_ERROR_STOP=1 -f supabase/test-logic.sql
--
-- Everything happens inside a transaction that is rolled back at the end, so
-- it is safe to point at a copy of production data. It is NOT safe to run on
-- production itself — it creates orders and moves stock before rolling back.
-- ============================================================================

\set ON_ERROR_STOP on
begin;

do $$
declare
  v_buyer  uuid;
  v_other  uuid;
  v_admin  uuid;
  v_milk   uuid;
  v_fish   uuid;
  v_coke   uuid;
  v_order  orders;
  v_item   items;
  v_avail  int;
  v_before int;
  v_msg    text;
  v_ok     int := 0;
begin
  -- --- fixtures -----------------------------------------------------------
  insert into app_users(telegram_id, first_name, is_admin)
  values (900001,'TestBuyer',false),(900002,'TestOther',false),(900009,'TestAdmin',true)
  on conflict (telegram_id) do nothing;

  select id into v_buyer from app_users where telegram_id = 900001;
  select id into v_other from app_users where telegram_id = 900002;
  select id into v_admin from app_users where telegram_id = 900009;

  select id into v_milk from items where sku = 'HP-MILK';
  select id into v_fish from items where sku = 'FC-HONEY-BBQ';
  select id into v_coke from items where sku = 'DR-COKE';

  if v_milk is null then
    raise exception 'seed.sql has not been applied — HP-MILK is missing';
  end if;

  update items set stock = 24, reserved = 0 where id in (v_milk, v_fish, v_coke);

  -- --- 1. totals are computed server-side ---------------------------------
  select * into v_order from create_order(v_buyer, 900001, 'Tester', 'note',
    jsonb_build_array(
      jsonb_build_object('item_id', v_milk, 'quantity', 2),
      jsonb_build_object('item_id', v_fish, 'quantity', 1)));

  if v_order.total_cents <> 640 then
    raise exception 'FAIL 1: expected 640 cents (2x120 + 400), got %', v_order.total_cents;
  end if;
  if v_order.status <> 'awaiting_payment' then
    raise exception 'FAIL 1: new order should await payment, got %', v_order.status;
  end if;
  if not ('Blk B Lounge' = any(v_order.collection_points)) then
    raise exception 'FAIL 1: collection point not derived from the category';
  end if;
  v_ok := v_ok + 1;

  -- --- 2. stock is reserved, not spent ------------------------------------
  select * into v_item from items where id = v_milk;
  if v_item.stock <> 24 or v_item.reserved <> 2 then
    raise exception 'FAIL 2: expected stock 24 / reserved 2, got % / %', v_item.stock, v_item.reserved;
  end if;
  v_ok := v_ok + 1;

  -- --- 3. approval spends the stock and writes the ledger -----------------
  perform approve_order(v_order.id, v_admin, 'verified');
  select * into v_item from items where id = v_milk;
  if v_item.stock <> 22 or v_item.reserved <> 0 then
    raise exception 'FAIL 3: expected stock 22 / reserved 0, got % / %', v_item.stock, v_item.reserved;
  end if;
  if not exists (select 1 from stock_movements
                 where order_id = v_order.id and reason = 'order_paid' and delta = -2) then
    raise exception 'FAIL 3: no ledger row for the paid order';
  end if;
  v_ok := v_ok + 1;

  -- --- 4. approving twice must not deduct twice ---------------------------
  perform approve_order(v_order.id, v_admin, 'double tap');
  select stock into v_before from items where id = v_milk;
  if v_before <> 22 then
    raise exception 'FAIL 4: second approval changed stock to %', v_before;
  end if;
  v_ok := v_ok + 1;

  -- --- 5. a paid order cannot be released ---------------------------------
  begin
    perform release_order(v_order.id, v_admin, 'cancelled', 'nope');
    raise exception 'FAIL 5: releasing a paid order should have raised';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_ALREADY_PAID%' then raise; end if;
  end;
  v_ok := v_ok + 1;

  -- --- 6. overselling is impossible ---------------------------------------
  update items set stock = 3, reserved = 0 where id = v_coke;
  begin
    perform create_order(v_other, 900002, 'Other', null,
      jsonb_build_array(jsonb_build_object('item_id', v_coke, 'quantity', 4)));
    raise exception 'FAIL 6: overselling should have raised';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'OUT_OF_STOCK%' then raise; end if;
  end;
  v_ok := v_ok + 1;

  -- --- 7. rejection puts the hold back on the shelf -----------------------
  select * into v_order from create_order(v_other, 900002, 'Other', null,
    jsonb_build_array(jsonb_build_object('item_id', v_coke, 'quantity', 2)));
  select stock - reserved into v_avail from items where id = v_coke;
  if v_avail <> 1 then raise exception 'FAIL 7: expected 1 available while held, got %', v_avail; end if;

  perform release_order(v_order.id, v_admin, 'rejected', 'blurry screenshot');
  select stock - reserved into v_avail from items where id = v_coke;
  if v_avail <> 3 then raise exception 'FAIL 7: rejection did not release the hold (avail %)', v_avail; end if;
  v_ok := v_ok + 1;

  -- --- 8. a closed store refuses orders -----------------------------------
  update settings set value = 'false'::jsonb where key = 'store_open';
  begin
    perform create_order(v_other, 900002, 'Other', null,
      jsonb_build_array(jsonb_build_object('item_id', v_coke, 'quantity', 1)));
    raise exception 'FAIL 8: a closed store should refuse orders';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'STORE_CLOSED%' then raise; end if;
  end;
  update settings set value = 'true'::jsonb where key = 'store_open';
  v_ok := v_ok + 1;

  -- --- 9. bad quantities are rejected -------------------------------------
  begin
    perform create_order(v_other, 900002, 'Other', null,
      jsonb_build_array(jsonb_build_object('item_id', v_coke, 'quantity', 0)));
    raise exception 'FAIL 9: quantity 0 should raise';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'BAD_QUANTITY%' then raise; end if;
  end;
  v_ok := v_ok + 1;

  -- --- 10. an empty cart is rejected --------------------------------------
  begin
    perform create_order(v_other, 900002, 'Other', null, '[]'::jsonb);
    raise exception 'FAIL 10: an empty cart should raise';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'EMPTY_CART%' then raise; end if;
  end;
  v_ok := v_ok + 1;

  -- --- 11. the janitor releases abandoned checkouts -----------------------
  select * into v_order from create_order(v_other, 900002, 'Other', null,
    jsonb_build_array(jsonb_build_object('item_id', v_coke, 'quantity', 2)));
  update orders set expires_at = now() - interval '1 hour' where id = v_order.id;
  perform expire_stale_orders();

  select status into v_msg from orders where id = v_order.id;
  if v_msg <> 'cancelled' then raise exception 'FAIL 11: stale order is %, expected cancelled', v_msg; end if;
  select stock - reserved into v_avail from items where id = v_coke;
  if v_avail <> 3 then raise exception 'FAIL 11: expiry did not release stock (avail %)', v_avail; end if;
  v_ok := v_ok + 1;

  -- --- 12. stock take records the delta -----------------------------------
  select * into v_item from set_stock(v_coke, v_admin, 40, 'stock take');
  if v_item.stock <> 40 then raise exception 'FAIL 12: set_stock gave %', v_item.stock; end if;
  if not exists (select 1 from stock_movements
                 where item_id = v_coke and delta = 37 and balance_after = 40) then
    raise exception 'FAIL 12: stock take delta not recorded';
  end if;
  v_ok := v_ok + 1;

  -- --- 13. stock never goes negative --------------------------------------
  select * into v_item from adjust_stock(v_coke, v_admin, -9999, 'correction', 'over-subtract');
  if v_item.stock <> 0 then raise exception 'FAIL 13: stock went to %', v_item.stock; end if;
  v_ok := v_ok + 1;

  -- --- 14. concurrent-order cap -------------------------------------------
  update items set stock = 50, reserved = 0 where id = v_coke;
  delete from orders where user_id = v_other;
  for i in 1..3 loop
    perform create_order(v_other, 900002, 'Other', null,
      jsonb_build_array(jsonb_build_object('item_id', v_coke, 'quantity', 1)));
  end loop;
  begin
    perform create_order(v_other, 900002, 'Other', null,
      jsonb_build_array(jsonb_build_object('item_id', v_coke, 'quantity', 1)));
    raise exception 'FAIL 14: a fourth open order should be refused';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'TOO_MANY_OPEN_ORDERS%' then raise; end if;
  end;
  v_ok := v_ok + 1;

  raise notice '';
  raise notice '  ✅ all % business-logic assertions passed', v_ok;
  raise notice '';
end $$;

rollback;
