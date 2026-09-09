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

/** Everyone who should hear about the shop's problems. */
function admins() {
  return query('select telegram_id from app_users where is_admin and not is_blocked');
}

function orderLines(order) {
  return order.items
    .map((i) => `  - ${i.quantity} x ${esc([i.name, i.variant].filter(Boolean).join(' - '))} - $${i.lineTotal}`)
    .join('\n');
}

const itemName = (i) => esc([i.name, i.variant].filter(Boolean).join(' - '));

/**
 * Ask the buyer to send their payment screenshot here, in the chat.
 *
 * The Mini App no longer takes the upload. A Telegram webview picking a photo
 * is the flakiest step in the whole shop: it is a different file picker on
 * every phone, it loses HEIC screenshots, and on some Android builds it opens
 * nothing at all. Sending a photo to a chat is the one thing every Telegram
 * user already knows how to do and every client does correctly.
 *
 * The prompt carries the order code, and `force_reply` keeps the buyer's
 * photo attached to this message, which is how the photo handler knows which
 * order it belongs to when someone has more than one on the go.
 */
export async function askBuyerForProof(order) {
  const body =
    `📸 <b>Send your payment screenshot</b>\n\n` +
    `Order <b>${esc(order.code)}</b> - $${order.total}\n\n` +
    `${orderLines(order)}\n\n` +
    `Pay <b>$${order.total}</b> by PayNow, then reply to this message with the ` +
    `screenshot of your bank confirmation.\n\n` +
    `Once it is in, take your snacks from ` +
    `<b>${esc((order.collectionPoints ?? []).join(' + ') || 'Blk B')}</b> straight away. ` +
    `An admin checks the payment afterwards.`;

  const row = await one('select telegram_id from orders where id = $1', [order.id]);
  if (!row) return false;

  return send(row.telegram_id, body, {
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `Screenshot for ${order.code}`,
    },
  });
}

/** Tell every admin that a screenshot is waiting for review. */
export async function notifyAdminsOfOrder(order, buyer) {
  const list = await admins();
  if (list.length === 0) {
    log.warn('Order needs review but no admins exist', { code: order.code });
    return 0;
  }

  const handle = buyer?.username ? `@${esc(buyer.username)}` : `id ${buyer?.telegram_id ?? '?'}`;
  const message =
    `🧾 <b>Payment to verify</b>\n\n` +
    `<b>${esc(order.code)}</b> - $${order.total}\n` +
    `From ${esc(order.buyerName)} (${handle})\n\n` +
    `${orderLines(order)}\n\n` +
    `📍 ${esc((order.collectionPoints ?? []).join(' + ') || 'Blk B')}\n` +
    (order.note ? `📝 ${esc(order.note)}\n` : '') +
    `\nThey have taken these already, so there is no rush. Verify when you next ` +
    `do a round: store, then the <b>Admin</b> tab.`;

  let sent = 0;
  for (const a of list) {
    if (await send(a.telegram_id, message)) sent += 1;
  }
  return sent;
}

/** Tell the buyer what an admin decided. */
export async function notifyBuyerOfDecision(order, decision) {
  const messages = {
    approved:
      `✅ <b>Payment verified</b>\n\n` +
      `Order <b>${esc(order.code)}</b> - $${order.total}\n\n` +
      `${orderLines(order)}\n\n` +
      `All settled, nothing more to do. Thanks for supporting STRIX! 🎉`,
    rejected:
      `⚠️ <b>We could not verify your payment</b>\n\n` +
      `Order <b>${esc(order.code)}</b> - $${order.total}\n` +
      (order.reviewNote ? `\nReason: ${esc(order.reviewNote)}\n` : '\n') +
      `\nYou already collected these items, so this one still needs settling. ` +
      `Send a clearer screenshot to this chat, or message an admin if you think ` +
      `this is a mistake.`,
  };

  const body = messages[decision];
  if (!body) return false;

  const row = await one('select telegram_id from orders where id = $1', [order.id]);
  if (!row) return false;

  return send(row.telegram_id, body);
}

/**
 * The shelf is nearly empty. Sent once per crossing, not once per sale, by
 * the caller in services/collation.service.js.
 */
export async function notifyAdminsOfLowStock(items, threshold = 2) {
  if (items.length === 0) return 0;
  const list = await admins();
  if (list.length === 0) {
    log.warn('Low stock but no admins exist', { items: items.length });
    return 0;
  }

  const lines = items
    .slice(0, 20)
    .map((i) => `  - ${itemName(i)} - <b>${i.available}</b> left`)
    .join('\n');
  const more = items.length > 20 ? `\n  ...and ${items.length - 20} more` : '';

  const message =
    `📉 <b>Running out</b>\n\n` +
    `${items.length === 1 ? 'This line is' : 'These lines are'} down to ` +
    `${threshold} or fewer:\n\n${lines}${more}\n\n` +
    `Open the store, then the <b>Admin</b> tab, to restock.`;

  let sent = 0;
  for (const a of list) {
    if (await send(a.telegram_id, message)) sent += 1;
  }
  return sent;
}

export default {
  askBuyerForProof, notifyAdminsOfOrder, notifyBuyerOfDecision,
  notifyAdminsOfLowStock, esc,
};
