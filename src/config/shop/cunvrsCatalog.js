// Approved storefront. A null price requires a staff quote.
const raw = [
  ['extra_charm','Extra Charm',5000,'ugc'],
  ['custom_charm','Custom Charm',10000,'ugc'],
  ['discount_10','10% Discount',10000,'ugc'],
  ['discount_25','25% Discount',30000,'ugc'],
  ['custom_necklace','Custom Necklace',50000,'ugc'],
  ['custom_accessory','Custom Accessory',75000,'ugc'],
  ['custom_clothing','Custom Clothing',75000,'ugc'],
  ['fastpass','Fastpass',100000,'ugc'],
  ['upload','Upload',167000,'ugc'],
  ['robux_50','50 Robux',20000,'robux'],
  ['robux_100','100 Robux',35000,'robux'],
  ['robux_250','250 Robux',67000,'robux'],
  ['robux_500','500 Robux',125000,'robux'],
  ['robux_1000','1,000 Robux',225000,'robux'],
  ['custom_role','Custom Role',30000,'discord'],
  ['vip','VIP',67000,'discord'],
  ['nitro_basic','Nitro Basic',50000,'discord'],
  ['nitro','Nitro',150000,'discord'],
  ['decoration_499','$4.99 Decoration',75000,'discord'],
  ['decoration_899','$8.99 Decoration',135000,'discord'],
  ['decoration_1299','$12.99 Decoration',195000,'discord'],
  ['decoration_1799','$17.99 Decoration',270000,'discord'],
  ['premium_reward_20_plus','$20+ Reward',null,'discord'],
];

export const CUNVRS_SHOP_CATEGORIES = Object.freeze({
  ugc: 'UGC Rewards',
  robux: 'Robux Rewards',
  discord: 'Discord Rewards',
});

export const CUNVRS_SHOP_CATALOG = Object.freeze(raw.map(([id,name,price,category]) =>
  Object.freeze({ id, name, price, category, enabled: price !== null })
));

export function getCatalogItem(id) {
  return CUNVRS_SHOP_CATALOG.find(item => item.id === id) ?? null;
}

export function findCatalogItem(input) {
  const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = normalize(input ?? '');
  return CUNVRS_SHOP_CATALOG.find(item =>
    normalize(item.id) === key || normalize(item.name) === key
  ) ?? null;
}
