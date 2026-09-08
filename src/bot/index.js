import { Telegraf } from 'telegraf';
import config from '../config.js';
import log from '../lib/logger.js';
import { upsertUser, isAdminTelegramId } from '../lib/auth.js';
import { query, one } from '../lib/db.js';
import * as catalogService from '../services/catalog.service.js';
import { esc } from './notify.js';

let bot = null;

/**
 * The bot instance, constructed on first use.
 *
 * On a long-running host `launchBot()` builds it at boot. On a serverless host
 * there is no boot: each cold start begins with an incoming webhook or an API
 * call that wants to send a notification, so the instance has to be able to
 * appear on demand. `createBot()` is idempotent, which makes both paths safe.
 */
export function getBot() {
  if (!bot) createBot();
  return bot;
}

/** Telegraf's ctx.from -> the shape upsertUser expects. */
function fromTelegraf(from) {
  return {
    id: from.id,
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    photoUrl: null,
  };
}

/**
 * The Mini App button. Telegram requires an https URL, so in local development
 * (http://localhost) we fall back to a plain link and tell the user why.
 */
function storeKeyboard() {
  const url = config.publicUrl;
  if (!url || !url.startsWith('https://')) return null;
  return {
    inline_keyboard: [[{ text: '🛒 Open Snax Store', web_app: { url } }]],
  };
}

export function createBot() {
  if (bot) return bot;
  bot = new Telegraf(config.telegram.botToken, {
    telegram: { apiRoot: config.telegram.apiRoot },
  });

  // Every update refreshes the user row, so /start is all it takes to become
  // a known user an admin can later promote.
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      try {
        ctx.state.user = await upsertUser(fromTelegraf(ctx.from));
      } catch (err) {
        log.error('upsertUser from bot failed', { error: err.message });
      }
    }
    return next();
  });

  bot.start(async (ctx) => {
    const keyboard = storeKeyboard();
    const name = esc(ctx.from.first_name ?? 'there');
    const text =
      `👋 Hey ${name}! Welcome to <b>${esc(config.store.name)}</b> — ${esc(config.store.academicYear)}.\n\n` +
      `🐼 <b>Snax</b> at Blk B Lounge · 🥤 <b>Drinks</b> at Blk B Pantry\n` +
      `We are open <b>24/7</b>.\n\n` +
      `Tap below to browse the menu, pay by PayNow and get your order confirmed — ` +
      `no more Google Forms.`;

    if (keyboard) {
      return ctx.replyWithHTML(text, { reply_markup: keyboard });
    }
    return ctx.replyWithHTML(
      `${text}\n\n⚠️ The store link is not configured yet. ` +
      `Set <code>PUBLIC_URL</code> to an https address and restart the bot.`
    );
  });

  bot.command('menu', async (ctx) => {
    try {
      const { categories } = await catalogService.getCatalog();
      if (categories.length === 0) return ctx.reply('The menu is empty right now.');

      const sections = categories.map((c) => {
        const lines = c.items.map((i) => {
          const label = esc([i.name, i.variant].filter(Boolean).join(' — '));
          const badge = !i.inStock ? ' <i>(sold out)</i>' : i.isLow ? ' ⚠️' : '';
          return `  • ${label} — <b>$${i.price}</b>${badge}`;
        }).join('\n');
        return `<b>${esc(c.name.toUpperCase())}</b>  <i>${esc(c.collectionPoint)}</i>\n${lines}`;
      });

      const keyboard = storeKeyboard();
      return ctx.replyWithHTML(
        `🍜 <b>Today's menu</b>\n\n${sections.join('\n\n')}`,
        keyboard ? { reply_markup: keyboard } : {}
      );
    } catch (err) {
      log.error('/menu failed', { error: err.message });
      return ctx.reply('Could not load the menu right now. Try again in a moment.');
    }
  });

  bot.command('orders', async (ctx) => {
    try {
      const rows = await query(
        `select code, status, total_cents, created_at from orders
          where telegram_id = $1 order by created_at desc limit 8`,
        [ctx.from.id]
      );
      if (rows.length === 0) return ctx.reply('You have not ordered anything yet. Try /start!');

      const labels = {
        awaiting_payment: '⏳ Awaiting payment',
        pending_review:   '🔍 Being verified',
        paid:             '✅ Paid — ready to collect',
        rejected:         '⚠️ Rejected',
        cancelled:        '✖️ Cancelled',
        collected:        '📦 Collected',
      };
      const list = rows.map((o) =>
        `<b>${esc(o.code)}</b> — $${(o.total_cents / 100).toFixed(2)}\n   ${labels[o.status] ?? o.status}`
      ).join('\n\n');

      return ctx.replyWithHTML(`🧾 <b>Your recent orders</b>\n\n${list}`);
    } catch (err) {
      log.error('/orders failed', { error: err.message });
      return ctx.reply('Could not load your orders right now.');
    }
  });

  bot.command('id', (ctx) =>
    ctx.replyWithHTML(
      `Your Telegram id is <code>${ctx.from.id}</code>.\n\n` +
      `Send this to a store admin if you need admin access.`
    )
  );

  bot.command('admin', async (ctx) => {
    if (!(await isAdminTelegramId(ctx.from.id))) {
      return ctx.reply('That command is for store admins only.');
    }
    try {
      const [pending, low] = await Promise.all([
        one("select count(*)::int as n from orders where status = 'pending_review'"),
        catalogService.getLowStockItems(),
      ]);
      const keyboard = storeKeyboard();
      const lowList = low.slice(0, 8)
        .map((i) => `  • ${esc([i.name, i.variant].filter(Boolean).join(' — '))} — <b>${i.available}</b>`)
        .join('\n');

      return ctx.replyWithHTML(
        `🛠 <b>Admin</b>\n\n` +
        `🔍 Awaiting verification: <b>${pending?.n ?? 0}</b>\n` +
        `📉 Low stock items: <b>${low.length}</b>\n` +
        (lowList ? `\n${lowList}\n` : '') +
        `\nOpen the store and switch to the <b>Admin</b> tab for stock taking and order review.`,
        keyboard ? { reply_markup: keyboard } : {}
      );
    } catch (err) {
      log.error('/admin failed', { error: err.message });
      return ctx.reply('Could not load the admin summary.');
    }
  });

  bot.help((ctx) =>
    ctx.replyWithHTML(
      `<b>STRIX Snax Store</b>\n\n` +
      `/start — open the store\n` +
      `/menu — today's menu and prices\n` +
      `/orders — your recent orders\n` +
      `/id — your Telegram id\n` +
      `/admin — admin summary (admins only)`
    )
  );

  // Data sent back from the Mini App via Telegram.WebApp.sendData().
  bot.on('message', async (ctx, next) => {
    const webAppData = ctx.message?.web_app_data;
    if (!webAppData) return next();
    log.info('web_app_data received', { from: ctx.from.id });
    return ctx.reply('Got it! Check the store for your order status.');
  });

  bot.catch((err, ctx) => {
    log.error('Bot handler threw', { error: err.message, update: ctx.updateType });
  });

  return bot;
}

/** The command list Telegram shows in the ☰ menu next to the input box. */
export const BOT_COMMANDS = [
  { command: 'start',  description: 'Open the Snax Store' },
  { command: 'menu',   description: "Today's menu and prices" },
  { command: 'orders', description: 'Your recent orders' },
  { command: 'id',     description: 'Show your Telegram id' },
  { command: 'admin',  description: 'Admin summary' },
];

/**
 * Tell Telegram about this deployment: the command list, the ☰ menu button
 * and, when a webhook URL is given, where to deliver updates.
 *
 * On a long-running host launchBot() does this at boot. A serverless
 * deployment never boots, so the same work is reachable over HTTP — see
 * src/routes/telegram-setup.js. Keeping it in one function means the two
 * paths cannot drift apart.
 */
export async function configureTelegram({
  publicUrl = config.publicUrl,
  webhookUrl = null,
  dropPendingUpdates = true,
} = {}) {
  const instance = createBot();
  const done = { commands: false, menuButton: false, webhook: false };

  await instance.telegram.setMyCommands(BOT_COMMANDS);
  done.commands = true;

  // A chat-menu button makes the store reachable from the ☰ next to the input
  // box. Telegram only accepts https here, so local development skips it.
  if (publicUrl && publicUrl.startsWith('https://')) {
    try {
      await instance.telegram.setChatMenuButton({
        menuButton: { type: 'web_app', text: 'Snax Store', web_app: { url: publicUrl } },
      });
      done.menuButton = true;
    } catch (err) {
      log.warn('Could not set chat menu button', { error: err.message });
    }
  }

  if (webhookUrl) {
    await instance.telegram.setWebhook(webhookUrl, {
      secret_token: config.telegram.webhookSecret || undefined,
      drop_pending_updates: dropPendingUpdates,
    });
    done.webhook = true;
    log.info('Telegram webhook registered', { url: webhookUrl });
  }

  return done;
}

export async function launchBot() {
  const instance = createBot();
  const useWebhook = config.telegram.useWebhook && config.telegram.webhookUrl;

  await configureTelegram({
    webhookUrl: useWebhook ? config.telegram.webhookUrl : null,
  });

  if (useWebhook) {
    log.info('Bot running via webhook', { url: config.telegram.webhookUrl });
  } else {
    // Fire and forget — launch() only resolves when polling stops.
    instance.launch({ dropPendingUpdates: true })
      .catch((err) => log.error('Bot polling stopped', { error: err.message }));
    log.info('Bot running via long polling');
  }

  return instance;
}

export default { createBot, launchBot, getBot, configureTelegram, BOT_COMMANDS };
