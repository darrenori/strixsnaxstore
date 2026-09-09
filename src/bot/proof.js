import * as orders from '../services/order.service.js';
import { sniffImage } from '../lib/image.js';
import { notifyAdminsOfOrder, esc } from './notify.js';
import log from '../lib/logger.js';

/**
 * Payment screenshots, collected in the chat.
 *
 * The Mini App used to take the upload itself. Inside Telegram's webview that
 * meant a file picker that behaves differently on every phone, drops HEIC
 * screenshots on some of them and opens nothing at all on others, and the
 * failure looks to the buyer like the shop being broken. Sending a photo to a
 * chat is the one file operation every Telegram user already knows works, so
 * that is where the shop asks for it now.
 *
 * Everything past "which order is this for" is the same service call the HTTP
 * route makes, so a screenshot that arrives here reserves, settles and
 * notifies exactly as one that arrives over the API.
 */

const CODE_PATTERN = /\bSNX-[A-Z0-9]{5}\b/i;

/** Telegram caps bot downloads at 20 MB; we cap lower, at what we will store. */
const MAX_BYTES = 10 * 1024 * 1024;

/** The biggest rendition of a photo, or an image sent as a file. */
function fileFrom(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    // Telegram lists renditions smallest first, and the last one is the only
    // one an admin can actually read a reference number off.
    const best = message.photo[message.photo.length - 1];
    return { fileId: best.file_id, size: best.file_size ?? 0, kind: 'photo' };
  }

  const doc = message?.document;
  if (doc && String(doc.mime_type ?? '').startsWith('image/')) {
    return { fileId: doc.file_id, size: doc.file_size ?? 0, kind: 'document' };
  }
  return null;
}

/** Pull an order code out of whatever text came with the picture. */
function codeIn(...texts) {
  for (const text of texts) {
    const match = String(text ?? '').match(CODE_PATTERN);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

/** Fetch the bytes Telegram is holding for a file id. */
async function download(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(String(link));
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('TOO_LARGE');

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('TOO_LARGE');
  return bytes;
}

/** One line per order, for the "which one?" keyboard. */
function chooserKeyboard(list) {
  return {
    inline_keyboard: list.map((o) => [{
      text: `${o.code} - $${o.total}`,
      callback_data: `proof:${o.id}`,
    }]),
  };
}

/**
 * Store the picture against an order and tell everyone who needs to know.
 * Shared by the photo handler and the "which order?" button.
 */
async function attach(ctx, order, file) {
  const user = ctx.state.user;

  let bytes;
  try {
    bytes = await download(ctx, file.fileId);
  } catch (err) {
    if (err.message === 'TOO_LARGE') {
      return ctx.reply('That image is over 10 MB. Send the screenshot itself rather than a full-size photo of it.');
    }
    log.error('Proof download failed', { code: order.code, error: err.message });
    return ctx.reply('Telegram would not give us that file. Try sending it again.');
  }

  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    return ctx.reply('That does not look like an image we can read. A JPG or PNG screenshot works best.');
  }

  let updated;
  try {
    updated = await orders.attachPaymentProof({
      orderId: order.id,
      user,
      bytes,
      mimeType: sniffed.mime,
      paymentRef: null,
      source: 'telegram',
    });
  } catch (err) {
    log.warn('Proof attach from Telegram failed', { code: order.code, error: err.message });
    return ctx.replyWithHTML(
      `⚠️ ${esc(err.message)}\n\nOpen the store and check <b>${esc(order.code)}</b>.`
    );
  }

  notifyAdminsOfOrder(updated, user).catch((err) =>
    log.error('Admin notify failed', { error: err.message }));

  const where = (updated.collectionPoints ?? []).join(' + ') || 'Blk B';
  return ctx.replyWithHTML(
    `✅ <b>Got it!</b>\n\n` +
    `Screenshot saved against <b>${esc(updated.code)}</b> - $${updated.total}.\n\n` +
    `🎉 Go and take your snacks from <b>${esc(where)}</b> now. An admin checks the ` +
    `payment afterwards and you will hear from us only if something looks off.`
  );
}

/**
 * A picture arrived in the chat. Work out which order it settles.
 *
 * In order of confidence: the buyer replied to our own prompt, which carries
 * the code; they typed a code in the caption; or they have exactly one order
 * waiting, which is the ordinary case. Only when several are open does anyone
 * get asked a question.
 */
export async function handleProofPhoto(ctx, next) {
  // A payment screenshot is a private thing between one buyer and the shop.
  // If the bot is ever added to a group, holiday photos in it are not proof
  // of anybody's order.
  if (ctx.chat?.type !== 'private') return next();

  const file = fileFrom(ctx.message);
  if (!file) {
    // A document that is not an image: say so rather than going quiet, which
    // is what a broken bot looks like from the outside.
    if (ctx.message?.document) {
      return ctx.reply('I can only read images. Send the payment screenshot as a photo.');
    }
    return next();
  }

  const user = ctx.state.user;
  if (!user) return ctx.reply('Press /start first so we know who you are.');

  const code = codeIn(ctx.message.caption, ctx.message.reply_to_message?.text);
  if (code) {
    const order = await orders.getOrderByCode(code, { userId: user.id });
    if (!order) {
      return ctx.replyWithHTML(`No order of yours has the code <b>${esc(code)}</b>.`);
    }
    if (!['awaiting_payment', 'rejected'].includes(order.status)) {
      return ctx.replyWithHTML(
        `<b>${esc(order.code)}</b> is not waiting for a screenshot. It is already ` +
        `<b>${esc(order.status.replace(/_/g, ' '))}</b>.`
      );
    }
    return attach(ctx, order, file);
  }

  const open = await orders.listOrdersAwaitingProof(user.id);
  if (open.length === 0) {
    return ctx.replyWithHTML(
      `Thanks, but you have no order waiting for a payment screenshot right now.\n\n` +
      `Open the store with /start, place your order, then send the screenshot here.`
    );
  }
  if (open.length === 1) return attach(ctx, open[0], file);

  // More than one open order and nothing to say which. Ask, as a reply to the
  // photo itself, so the answer can find the picture again without us having
  // to hold it anywhere between the two messages.
  return ctx.replyWithHTML(
    'Which order is that screenshot for?',
    { reply_markup: chooserKeyboard(open), reply_parameters: { message_id: ctx.message.message_id } }
  );
}

/** The buyer picked an order from the keyboard above. */
export async function handleProofChoice(ctx) {
  const orderId = String(ctx.callbackQuery.data ?? '').slice('proof:'.length);
  const user = ctx.state.user;

  // The question was posted as a reply to the picture, so the picture is
  // still reachable from the button that answers it.
  const file = fileFrom(ctx.callbackQuery.message?.reply_to_message);
  if (!file) {
    await ctx.answerCbQuery('That photo is too old to use. Send it again.');
    return undefined;
  }
  if (!user) {
    await ctx.answerCbQuery('Press /start first.');
    return undefined;
  }

  const order = await orders.getOrder(orderId, { userId: user.id }).catch(() => null);
  if (!order || !['awaiting_payment', 'rejected'].includes(order.status)) {
    await ctx.answerCbQuery('That order is no longer waiting for a screenshot.');
    return undefined;
  }

  await ctx.answerCbQuery(`Saving against ${order.code}`);
  // Take the keyboard away so the same photo cannot be filed twice.
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  return attach(ctx, order, file);
}

export default { handleProofPhoto, handleProofChoice };
