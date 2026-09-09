/**
 * What an uploaded file actually is.
 *
 * A declared mime type is just a string the sender chose, and a filename is
 * worth even less, so the bytes are asked instead. Screenshots reach the shop
 * two ways now, through the Mini App and through the bot, and both go past
 * here before anything is stored.
 */

/** The formats the payment_proofs table will accept. */
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/**
 * Identify an image by its magic bytes, or return null.
 *
 * HEIC matters more than it looks: an iPhone screenshot shared into Telegram
 * can arrive as one, and refusing it would send the buyer round in circles
 * converting a file they cannot see the format of.
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'mif1', 'heim'].includes(brand)) {
      return { ext: 'heic', mime: 'image/heic' };
    }
  }
  return null;
}

export default { sniffImage, ALLOWED_MIME };
