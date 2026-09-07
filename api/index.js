/**
 * Vercel serverless entry point.
 *
 * Vercel gives each request a function invocation rather than a long-lived
 * process, so there is no boot phase here: the Express app is imported (which
 * builds routes and the Postgres pool), and everything that would normally
 * happen at startup — creating the bot, sweeping expired holds — happens
 * lazily on the path that needs it.
 *
 * The same `src/index.js` still runs as an ordinary server with `npm start`,
 * so this file adds a deployment target without forking the app.
 */
import app from '../src/index.js';

export default app;

// Static assets are served from the CDN by vercel.json, so this function only
// ever handles API calls, the webhook and cron — none of which want a body
// parser other than the ones the app installs itself.
export const config = {
  api: { bodyParser: false },
  maxDuration: 30,
};
