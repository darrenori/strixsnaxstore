-- ============================================================================
-- STRIX Snax Store — menu seed (AY2026/2027)
-- Transcribed from the Blk B Lounge (snax) and Blk B Pantry (drinks) posters.
-- Safe to re-run: everything is upserted on the natural key.
-- ============================================================================

insert into categories (slug, name, kind, collection_point, tagline, accent, sort_order) values
  ('hello-panda',    'Hello Panda',    'snack', 'Blk B Lounge', 'Creamy filled biscuits',            'sky',   10),
  ('roller-coasters','Roller Coasters','snack', 'Blk B Lounge', 'Bold twists, big crunch',           'blue',  20),
  ('fish-crackers',  'Fish Crackers',  'snack', 'Blk B Lounge', 'Imported directly from Malaysia',   'gold',  30),
  ('noodles',        'Noodles',        'snack', 'Blk B Lounge', 'Hot bowls for late nights',         'red',   40),
  ('lotte-pepero',   'Lotte Pepero',   'snack', 'Blk B Lounge', 'Chocolate-dipped sticks',           'navy',  50),
  ('under-1-deals',  'Under $1 Deals', 'drink', 'Blk B Pantry', 'Everything below a dollar',         'sky',   60),
  ('classic-drinks', 'Classic Drinks', 'drink', 'Blk B Pantry', 'The everyday favourites',           'blue',  70),
  ('special-edition','Special Edition','drink', 'Blk B Pantry', 'Limited run',                       'red',   80)
on conflict (slug) do update set
  name = excluded.name, kind = excluded.kind,
  collection_point = excluded.collection_point, tagline = excluded.tagline,
  accent = excluded.accent, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- SNAX — Blk B Lounge
-- ---------------------------------------------------------------------------
insert into items (category_id, sku, name, variant, description, price_cents, emoji,
                   is_special, is_top_pick, stock, low_stock_at, sort_order)
select c.id, v.sku, v.name, v.variant, v.description, v.price_cents, v.emoji,
       v.is_special, v.is_top_pick, v.stock, v.low_stock_at, v.sort_order
from (values
  -- Hello Panda  $1.20
  ('hello-panda','HP-MILK',      'Hello Panda','Milk',      'Creamy bites of joy in every crunch of biscuits', 120,'🐼',false,false,24,5,10),
  ('hello-panda','HP-CARAMEL',   'Hello Panda','Caramel',   'Golden sweetness wrapped in playful delight',     120,'🐼',false,false,24,5,20),
  ('hello-panda','HP-CHOCOLATE', 'Hello Panda','Chocolate', 'Rich cocoa taste in every fun-filled biscuit shell',120,'🐼',false,false,24,5,30),

  -- Roller Coasters  $1.00
  ('roller-coasters','RC-BBQ',    'Roller Coasters','BBQ',    'Smoky twists packed with bold crunch!',  100,'🎢',false,false,24,5,10),
  ('roller-coasters','RC-CHEESE', 'Roller Coasters','Cheese', 'Cheesy spirals bursting with fun flavour',100,'🎢',false,false,24,5,20),

  -- Fish Crackers  $4.00  (the SPECIAL)
  ('fish-crackers','FC-HONEY-BBQ',   'Fish Crackers','Honey BBQ',   'A finger licking good snack you will surely crave for more after the first bite. Imported directly from Malaysia.',400,'🐠',true,false,12,3,10),
  ('fish-crackers','FC-HONEY-BUTTER','Fish Crackers','Honey Butter','A finger licking good snack you will surely crave for more after the first bite. Imported directly from Malaysia.',400,'🐠',true,false,12,3,20),
  ('fish-crackers','FC-HOT-SPICY',   'Fish Crackers','Hot & Spicy', 'A finger licking good snack you will surely crave for more after the first bite. Imported directly from Malaysia.',400,'🐠',true,false,12,3,30),

  -- Noodles
  ('noodles','ND-NONGSHIM',      'Nongshim Instant Bowl',  null,             null,                                  210,'🍜',false,false,18,4,10),
  ('noodles','ND-SAMYANG-CARBO', 'Samyang Instant Ramen',  'Carbo',          'Top pick among our noodle options',    230,'🔥',false,true, 18,4,20),
  ('noodles','ND-NISSIN-TOMYAM', 'Nissin Cup Noodles',     'Tom Yam Seafood',null,                                  190,'🍲',false,false,18,4,30),
  ('noodles','ND-NISSIN-CHICKEN','Nissin Cup Noodles',     'Chicken',        null,                                  190,'🍲',false,false,18,4,40),
  ('noodles','ND-NISSIN-KYUSHU', 'Nissin Cup Noodles',     'Kyushu White',   null,                                  190,'🍲',false,false,18,4,50),
  ('noodles','ND-NISSIN-SEAFOOD','Nissin Cup Noodles',     'Seafood',        null,                                  190,'🍲',false,false,18,4,60),

  -- Lotte Pepero  $1.60
  ('lotte-pepero','LP-ALMOND',      'Lotte Pepero','Almond',      null,160,'🍫',false,false,18,4,10),
  ('lotte-pepero','LP-WHITE-COOKIE','Lotte Pepero','White Cookie',null,160,'🍫',false,false,18,4,20),

  -- ---------------------------------------------------------------------
  -- DRINKS — Blk B Pantry
  -- ---------------------------------------------------------------------
  ('under-1-deals','DR-POKKA-GREENTEA','Pokka Green Tea','',null,80,'🍵',false,false,24,5,10),
  ('under-1-deals','DR-MILO-PACKET',   'Milo Packets',   '',null,80,'🥤',false,false,24,5,20),

  ('classic-drinks','DR-COKE',           'Coke',          '',null,100,'🥤',false,false,24,5,10),
  ('classic-drinks','DR-COKE-ZERO',      'Coke Zero',     '',null,100,'🥤',false,false,24,5,20),
  ('classic-drinks','DR-100PLUS',        '100 Plus',      '',null,100,'🥤',false,false,24,5,30),
  ('classic-drinks','DR-100PLUS-ZERO',   '100 Plus Zero', '',null,100,'🥤',false,false,24,5,40),

  ('special-edition','DR-RED-BULL','Red Bull','','The burst of energy you need to soar high!!',140,'⚡',true,false,18,4,10)
) as v(cat_slug, sku, name, variant, description, price_cents, emoji, is_special, is_top_pick, stock, low_stock_at, sort_order)
join categories c on c.slug = v.cat_slug
on conflict (sku) do update set
  name = excluded.name,
  variant = excluded.variant,
  description = excluded.description,
  price_cents = excluded.price_cents,
  emoji = excluded.emoji,
  is_special = excluded.is_special,
  is_top_pick = excluded.is_top_pick,
  low_stock_at = excluded.low_stock_at,
  sort_order = excluded.sort_order,
  category_id = excluded.category_id;
  -- NB: stock is deliberately NOT overwritten on re-run, so re-seeding the
  -- menu never clobbers a real stock-take.
