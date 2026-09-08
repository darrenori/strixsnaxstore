import { query, one } from '../lib/db.js';
import { getBot } from './index.js';
import log from '../lib/logger.js';

/** Escape the small set of characters Telegram's HTML parse mode cares about. */
export function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function send(telegramId, html, extra = {}) {
  const bot = getBot();
  if (!bot) return false;
  try {
    await bot.telegram.sendMessage(telegramId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
    return true;
  } catch (err) {
    // A user who blocked the bot is normal, not an incident.
    log.warn('Telegram send failed', { telegramId: String(telegramId), error: err.message });
    return false;
  }
}

function orderLines(order) {
  return order.items
    .map((i) => `  • ${i.quantity} × ${esc([i.name, i.variant].filter(Boolean).join(' — '))} — $${i.lineTotal}`)
    .join('\n');
}

/** Tell every admin that a screenshot is waiting for review. */
export async function notifyAdminsOfOrder(order, buyer) {
  const admins = await query(
    'select telegram_id from app_users where is_admin and not is_blocked'
  );
  if (admins.length === 0) {
    log.warn('Order needs review but no admins exist', { code: order.code });
    return 0;
  }

  const handle = buyer?.username ? `@${esc(buyer.username)}` : `id ${buyer?.telegram_id ?? '?'}`;
  const message =
    `🧾 <b>Payment to verify</b>\n\n` +
    `<b>${esc(order.code)}</b> — $${order.total}\n` +
    `From ${esc(order.buyerName)} (${handle})\n\n` +
    `${orderLines(order)}\n\n` +
    `📍 ${esc((order.collectionPoints ?? []).join(' + ') || 'Blk B')}\n` +
    (order.note ? `📝 ${esc(order.note)}\n` : '') +
    `\nThey have taken these already — no rush. Verify when you next do a ` +
    `round: store → <b>Admin</b> tab.`;

  let sent = 0;
  for (const a of admins) {
    if (await send(a.telegram_id, message)) sent += 1;
  }
  return sent;
}

/** Tell the buyer what an admin decided. */
export async function notifyBuyerOfDecision(order, decision) {
  const messages = {
    approved:
      `✅ <b>Payment verified</b>\n\n` +
      `Order <b>${esc(order.code)}</b> — $${order.total}\n\n` +
      `${orderLines(order)}\n\n` +
      `All settled — nothing more to do. Thanks for supporting STRIX! 🎉`,
    rejected:
      `⚠️ <b>We could not verify your payment</b>\n\n` +
      `Order <b>${esc(order.code)}</b> — $${order.total}\n` +
      (order.reviewNote ? `\nReason: ${esc(order.reviewNote)}\n` : '\n') +
      `\nYou already collected these items, so this one still needs settling. ` +
      `Open the store and upload a clearer screenshot, or message an admin if ` +
      `you think this is a mistake.`,
    collected:
      `📦 <b>Order collected</b>\n\n` +
      `<b>${esc(order.code)}</b> is marked as picked up. Enjoy! 🐼`,
  };

  const body = messages[decision];
  if (!body) return false;

  const row = await one('select telegram_id from orders where id = $1', [order.id]);
  if (!row) return false;

  return send(row.telegram_id, body);
}

/** Nightly-ish nudge when the shelf is running dry. */
export async function notifyAdminsOfLowStock(items) {
  if (items.length === 0) return 0;
  const admins = await query(
    'select telegram_id from app_users where is_admin and not is_blocked'
  );

  const list = items
    .slice(0, 15)
    .map((i) => `  • ${esc([i.name, i.variant].filter(Boolean).join(' — '))} — <b>${i.available}</b> left`)
    .join('\n');
  const message = `📉 <b>Low stock</b>\n\n${list}\n\nOpen the Admin tab to restock.`;

  let sent = 0;
  for (const a of admins) {
    if (await send(a.telegram_id, message)) sent += 1;
  }
  return sent;
}

export default { notifyAdminsOfOrder, notifyBuyerOfDecision, notifyAdminsOfLowStock, esc };
