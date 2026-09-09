import { Router } from 'express';
import { Readable } from 'node:stream';
import multer from 'multer';
import { z } from 'zod';
import * as orders from '../services/order.service.js';
import { notifyAdminsOfOrder, askBuyerForProof } from '../bot/notify.js';
import { sniffImage } from '../lib/image.js';
import config from '../config.js';
import log from '../lib/logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// Validation. The client is never trusted with prices - only ids and counts.
// ---------------------------------------------------------------------------
const cartSchema = z.object({
  buyerName: z.string().trim().min(1, 'Tell us your name').max(80),
  note: z.string().trim().max(280).optional().or(z.literal('')),
  cart: z.array(z.object({
    itemId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99),
  })).min(1, 'Your cart is empty').max(40),
});

const proofSchema = z.object({
  paymentRef: z.string().trim().max(64).optional().or(z.literal('')),
});

/** Images only, held in memory - nothing ever touches the app's disk. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.store.maxUploadBytes, files: 1 },
  fileFilter(_req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (!allowed.includes(file.mimetype)) {
      const err = new Error('Upload a JPG, PNG or WEBP screenshot.');
      err.status = 400;
      return cb(err);
    }
    return cb(null, true);
  },
});

/**
 * Replay a request body a serverless runtime already read.
 *
 * Vercel and friends buffer the whole body before the handler runs. For JSON
 * that is a convenience; for a file upload it is fatal - multer waits on a
 * stream that has already ended and the request hangs until the function
 * times out. The bytes are still there in req.body, so hand multer a stream
 * that replays them. On an ordinary server nothing parses multipart bodies,
 * so req.body is undefined here and this does nothing at all.
 */
function replayBufferedUpload(req, _res, next) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return next();

  const replay = Readable.from([req.body]);
  req.pipe = replay.pipe.bind(replay);
  req.unpipe = replay.unpipe.bind(replay);
  delete req.body;
  req._body = false;
  return next();
}

// ---------------------------------------------------------------------------
// Buyer routes
// ---------------------------------------------------------------------------

router.post('/orders', async (req, res, next) => {
  try {
    const parsed = cartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid order.' });
    }

    const result = await orders.placeOrder({
      user: req.user,
      buyerName: parsed.data.buyerName,
      note: parsed.data.note || null,
      cart: parsed.data.cart,
    });
    return res.status(201).json(result);
  } catch (err) { return next(err); }
});

router.get('/orders', async (req, res, next) => {
  try {
    res.json({ orders: await orders.listUserOrders(req.user.id) });
  } catch (err) { next(err); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    res.json(await orders.getOrderWithPayment(req.params.id, { userId: req.user.id }));
  } catch (err) { next(err); }
});

router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    res.json({ order: await orders.cancelOrder({ orderId: req.params.id, user: req.user }) });
  } catch (err) { next(err); }
});

/**
 * Ask the bot to collect the payment screenshot in the chat.
 *
 * This is what the Mini App's pay screen presses instead of opening a file
 * picker. A Telegram webview picking an image is the least reliable step in
 * the whole shop, and sending a photo to a chat is the one thing every
 * Telegram user has already done a hundred times.
 */
router.post('/orders/:id/request-proof', async (req, res, next) => {
  try {
    const order = await orders.getOrder(req.params.id, { userId: req.user.id });
    if (!['awaiting_payment', 'rejected'].includes(order.status)) {
      return res.status(409).json({
        error: order.status === 'pending_review'
          ? 'We already have a screenshot for that order.'
          : 'That order is not waiting for a payment screenshot.',
        code: 'ORDER_NOT_PAYABLE',
      });
    }

    const sent = await askBuyerForProof(order);
    if (!sent) {
      return res.status(502).json({
        error: 'We could not message you on Telegram. Open a chat with the bot and press Start, then try again.',
        code: 'NOTIFY_FAILED',
      });
    }

    await orders.markProofRequested(order.id);
    return res.json({ ok: true, order: await orders.getOrder(order.id, { userId: req.user.id }) });
  } catch (err) { return next(err); }
});

/**
 * Upload the PayNow screenshot over HTTP.
 *
 * The Mini App no longer uses this; it asks the bot to collect the screenshot
 * in the chat instead. The route stays as the way in for anyone who cannot,
 * and it is the same service call the bot makes, so both paths reserve,
 * settle and notify identically.
 */
router.post('/orders/:id/proof', replayBufferedUpload, upload.single('proof'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Attach your payment screenshot.' });

    const sniffed = sniffImage(req.file.buffer);
    if (!sniffed) {
      return res.status(400).json({ error: 'That file is not a readable image.' });
    }

    const parsed = proofSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payment reference.' });

    // Owner check happens inside attachPaymentProof, but read the order first
    // so a stray id never reaches the write path at all.
    await orders.getOrder(req.params.id, { userId: req.user.id });

    const order = await orders.attachPaymentProof({
      orderId: req.params.id,
      user: req.user,
      bytes: req.file.buffer,
      mimeType: sniffed.mime,
      paymentRef: parsed.data.paymentRef || null,
    });

    // Ping the admins, but never make the buyer wait on Telegram's API.
    notifyAdminsOfOrder(order, req.user).catch((err) =>
      log.error('Admin notify failed', { error: err.message })
    );

    return res.json({ order });
  } catch (err) { return next(err); }
});

export default router;
