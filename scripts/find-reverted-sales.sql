-- A sale followed by a "Sheet edit" correction on the same item that adds the
-- sold packets straight back, with no other movement on that item in between.
with moves as (
  select m.*, lag(m.id)            over w as prev_id,
              lag(m.reason)        over w as prev_reason,
              lag(m.delta)         over w as prev_delta,
              lag(m.balance_after) over w as prev_balance,
              lag(m.order_id)      over w as prev_order
    from stock_movements m
  window w as (partition by m.item_id order by m.created_at, m.id)
)
select i.sku, i.name, i.variant, o.code as order_code,
       mv.prev_delta as sold, mv.delta as added_back,
       mv.created_at as reverted_at
  from moves mv
  join items i on i.id = mv.item_id
  left join orders o on o.id = mv.prev_order
 where mv.reason = 'correction'
   and mv.note like 'Sheet edit%'
   and mv.prev_reason = 'order_paid'
   and mv.delta = -mv.prev_delta
   and mv.balance_after = mv.prev_balance - mv.prev_delta
 order by i.sku, mv.created_at;
