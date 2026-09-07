import { Router } from 'express';
import * as catalog from '../services/catalog.service.js';
import config from '../config.js';

const router = Router();

/** Everything the storefront needs on first paint. */
router.get('/catalog', async (req, res, next) => {
  try {
    const [data, settings] = await Promise.all([catalog.getCatalog(), catalog.getSettings()]);
    res.json({
      ...data,
      store: {
        name: config.store.name,
        academicYear: config.store.academicYear,
        open: settings.store_open !== false,
        announcement: settings.announcement ?? null,
      },
    });
  } catch (err) { next(err); }
});

/** Who am I, and may I see the admin tab? */
router.get('/me', (req, res) => {
  res.json({
    id: req.user.id,
    telegramId: String(req.user.telegram_id),
    username: req.user.username,
    firstName: req.user.first_name,
    lastName: req.user.last_name,
    displayName: req.user.display_name,
    photoUrl: req.user.photo_url,
    isAdmin: req.user.is_admin,
    ordersCount: req.user.orders_count,
  });
});

export default router;
