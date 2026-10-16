import { waitUntil } from '@vercel/functions';
import log from './logger.js';

/**
 * Run work the caller is not waiting on, and keep the host alive for it.
 *
 * On a long-lived server a promise left running simply finishes. On Vercel
 * the invocation is frozen the moment the response is sent, so a Sheets write
 * or a Telegram message started "in the background" stalls half way, holding
 * a socket that is dead by the time the instance thaws. The next request then
 * queues behind it: an Approve that hangs until the function times out is
 * exactly that. waitUntil tells Vercel to keep the invocation running until
 * the promise settles; anywhere else it is a no-op.
 *
 * Never rejects: an unhandled rejection takes the whole process down on Node.
 */
export function afterResponse(label, task) {
  const work = Promise.resolve()
    .then(task)
    .catch((err) => log.error(`${label} failed`, { error: err.message }));
  try {
    waitUntil(work);
  } catch { /* not on Vercel */ }
  return work;
}

export default { afterResponse };
