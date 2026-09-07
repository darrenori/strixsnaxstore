import { Router } from 'express';
import { z } from 'zod';
import * as orders from '../services/order.service.js';
import * as admin from '../services/admin.service.js';
import * as catalog from '../services/catalog.service.js';
import { notifyBuyerOfDecision } from '../bot/notify.js';
import { sheetsEnabled } from '../lib/sheets.js';
import config from '../config.js';
import log from '../lib/logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get('/admin/summary', async (req, res, next) => {
  try {
    const [stats, low, settings] = await Promise.all([
      orders.getStats(),
      catalog.getLowStockItems(),
      catalog.getSettings(),
    ]);
    res.json({
      stats,
      lowStock: low.map((i) => ({
        id: i.id, sku: i.sku, name: i.name, variant: i.variant,
        available: i.available, lowStockAt: i.low_stock_at,
      })),
      settings: {
        storeOpen: settings.store_open !== false,
        announcement: settings.announcement ?? '',
      },
      integrations: {
        sheets: sheetsEnabled(),
        sheetUrl: config.sheets.spreadsheetId
          ? `https://docs.google.com/spreadsheets/d/${config.sheets.spreadsheetId}`
          : null,
        paynowDynamic: Boolean(config.paynow.proxyValue),
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Order review queue
// ---------------------------------------------------------------------------

const statusSchema = z.enum([
  'awaiting_payment', 'pending_review', 'paid', 'rejected', 'cancelled', 'collected',
]);

router.get('/admin/orders', async (req, res, next) => {
  try {
    const status = req.query.status && statusSchema.safeParse(req.query.status).success
      ? req.query.status
      : null;
    res.json({ orders: await orders.listOrders({ status }) });
  } catch (err) { next(err); }
});

/** Short-lived signed URL for the payment screenshot. */
router.get('/admin/orders/:id/proof', async (req, res, next) => {
  try {
    const url = await orders.getProofUrl(req.params.id);
    if (!url) return res.status(404).json({ error: 'No screenshot on that order.' });
    return res.json({ url, expiresIn: 300 });
  } catch (err) { return next(err); }
});

const decisionSchema = z.object({ note: z.string().trim().max(280).optional().or(z.literal('')) });

router.post('/admin/orders/:id/approve', async (req, res, next) => {
  try {
    const parsed = decisionSchema.safeParse(req.body ?? {});
    const order = await orders.approveOrder({
      orderId: req.params.id,
      admin: req.user,
      note: parsed.success ? parsed.data.note || null : null,
    });
    notifyBuyerOfDecision(order, 'approved').catch((e) => log.error('Notify failed', { error: e.message }));
    return res.json({ order });
  } catch (err) { return next(err); }
});

router.post('/admin/orders/:id/reject', async (req, res, next) => {
  try {
    const parsed = decisionSchema.safeParse(req.body ?? {});
    const order = await orders.rejectOrder({
      orderId: req.params.id,
      admin: req.user,
      note: parsed.success ? parsed.data.note || null : null,
    });
    notifyBuyerOfDecision(order, 'rejected').catch((e) => log.error('Notify failed', { error: e.message }));
    return res.json({ order });
  } catch (err) { return next(err); }
});

router.post('/admin/orders/:id/collected', async (req, res, next) => {
  try {
    const order = await orders.markCollected({ orderId: req.params.id, admin: req.user });
    notifyBuyerOfDecision(order, 'collected').catch((e) => log.error('Notify failed', { error: e.message }));
    return res.json({ order });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Stock taking
// ---------------------------------------------------------------------------

router.get('/admin/catalog', async (req, res, next) => {
  try {
    res.json(await catalog.getAdminCatalog());
  } catch (err) { next(err); }
});

const setStockSchema = z.object({
  count: z.number().int().min(0).max(100000),
  note: z.string().trim().max(140).optional().or(z.literal('')),
});

router.post('/admin/items/:id/stock', async (req, res, next) => {
  try {
    const parsed = setStockSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a whole number of units.' });
    const item = await admin.setStock({
      itemId: req.params.id, admin: req.user,
      count: parsed.data.count, note: parsed.data.note || 'Stock take',
    });
    return res.json({ item });
  } catch (err) { return next(err); }
});

const adjustSchema = z.object({
  delta: z.number().int().min(-10000).max(10000).refine((n) => n !== 0, 'Delta cannot be zero'),
  reason: z.enum(['restock', 'manual_adjust', 'spoilage', 'correction']).default('manual_adjust'),
  note: z.string().trim().max(140).optional().or(z.literal('')),
});

router.post('/admin/items/:id/adjust', async (req, res, next) => {
  try {
    const parsed = adjustSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid adjustment.' });
    const item = await admin.adjustStock({
      itemId: req.params.id, admin: req.user,
      delta: parsed.data.delta, reason: parsed.data.reason, note: parsed.data.note || null,
    });
    return res.json({ item });
  } catch (err) { return next(err); }
});

const bulkSchema = z.object({
  entries: z.array(z.object({
    itemId: z.string().uuid(),
    count: z.number().int().min(0).max(100000),
  })).min(1).max(200),
  note: z.string().trim().max(140).optional().or(z.literal('')),
});

router.post('/admin/stock-take', async (req, res, next) => {
  try {
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid stock take.' });
    const results = await admin.bulkSetStock({
      admin: req.user,
      entries: parsed.data.entries.map((e) => ({ ...e, note: parsed.data.note || 'Stock take' })),
    });
    await admin.syncCatalogToSheets();
    return res.json({ results, updated: results.filter((r) => r.ok).length });
  } catch (err) { return next(err); }
});

router.get('/admin/stock-movements', async (req, res, next) => {
  try {
    const itemId = typeof req.query.itemId === 'string' && req.query.itemId ? req.query.itemId : null;
    res.json({ movements: await admin.listStockMovements({ itemId }) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Item management
// ---------------------------------------------------------------------------

const itemSchema = z.object({
  categoryId: z.string().uuid(),
  sku: z.string().trim().max(40).optional().or(z.literal('')),
  name: z.string().trim().min(1).max(80),
  variant: z.string().trim().max(60).optional().or(z.literal('')),
  description: z.string().trim().max(280).optional().or(z.literal('')),
  priceCents: z.number().int().min(0).max(100000),
  emoji: z.string().trim().max(8).optional().or(z.literal('')),
  imageUrl: z.string().trim().url().max(500).optional().or(z.literal('')),
  isSpecial: z.boolean().optional(),
  isTopPick: z.boolean().optional(),
  isActive: z.boolean().optional(),
  stock: z.number().int().min(0).max(100000).optional(),
  lowStockAt: z.number().int().min(0).max(10000).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});

router.post('/admin/items', async (req, res, next) => {
  try {
    const parsed = itemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid item.' });
    }
    return res.status(201).json({ item: await admin.createItem({ admin: req.user, payload: parsed.data }) });
  } catch (err) { return next(err); }
});

router.patch('/admin/items/:id', async (req, res, next) => {
  try {
    const parsed = itemSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid change.' });
    }
    return res.json({ item: await admin.updateItem({ admin: req.user, itemId: req.params.id, patch: parsed.data }) });
  } catch (err) { return next(err); }
});

router.delete('/admin/items/:id', async (req, res, next) => {
  try {
    res.json({ item: await admin.archiveItem({ admin: req.user, itemId: req.params.id }) });
  } catch (err) { next(err); }
});

const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  slug: z.string().trim().max(60).optional().or(z.literal('')),
  kind: z.enum(['snack', 'drink']),
  collectionPoint: z.string().trim().max(60).optional().or(z.literal('')),
  tagline: z.string().trim().max(120).optional().or(z.literal('')),
  accent: z.enum(['blue', 'red', 'navy', 'gold', 'sky']).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});

router.post('/admin/categories', async (req, res, next) => {
  try {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid category.' });
    }
    return res.status(201).json({ category: await admin.createCategory({ admin: req.user, payload: parsed.data }) });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// People + settings
// ---------------------------------------------------------------------------

router.get('/admin/users', async (req, res, next) => {
  try {
    res.json({ users: await admin.listUsers({ adminsOnly: req.query.admins === '1' }) });
  } catch (err) { next(err); }
});

const roleSchema = z.object({
  telegramId: z.union([z.string(), z.number()]).transform((v) => Number(v))
    .refine((n) => Number.isFinite(n) && n > 0, 'Enter a numeric Telegram id'),
  isAdmin: z.boolean(),
});

router.post('/admin/users/role', async (req, res, next) => {
  try {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.' });
    const user = await admin.setAdmin({
      admin: req.user, targetTelegramId: parsed.data.telegramId, isAdmin: parsed.data.isAdmin,
    });
    return res.json({ user });
  } catch (err) { return next(err); }
});

const blockSchema = z.object({
  telegramId: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  isBlocked: z.boolean(),
});

router.post('/admin/users/block', async (req, res, next) => {
  try {
    const parsed = blockSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request.' });
    const user = await admin.setBlocked({
      admin: req.user, targetTelegramId: parsed.data.telegramId, isBlocked: parsed.data.isBlocked,
    });
    return res.json({ user });
  } catch (err) { return next(err); }
});

const settingSchema = z.object({
  storeOpen: z.boolean().optional(),
  announcement: z.string().trim().max(200).optional(),
});

router.post('/admin/settings', async (req, res, next) => {
  try {
    const parsed = settingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid settings.' });
    if (parsed.data.storeOpen !== undefined) await catalog.setSetting('store_open', parsed.data.storeOpen);
    if (parsed.data.announcement !== undefined) await catalog.setSetting('announcement', parsed.data.announcement);
    return res.json({ settings: await catalog.getSettings() });
  } catch (err) { return next(err); }
});

/** Force a full catalogue push into the spreadsheet. */
router.post('/admin/sheets/sync', async (req, res, next) => {
  try {
    if (!sheetsEnabled()) {
      return res.status(400).json({ error: 'Google Sheets is not configured on the server.' });
    }
    const ok = await admin.syncCatalogToSheets();
    return res.json({ ok });
  } catch (err) { return next(err); }
});

export default router;
