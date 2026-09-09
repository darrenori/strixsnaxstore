import QRCode from 'qrcode';
import config from '../config.js';

/**
 * PayNow QR generation (EMVCo / SGQR).
 *
 * A static QR - the one printed on the poster - makes the buyer type the
 * amount themselves, which is exactly where "I paid $1.20 instead of $12.00"
 * mistakes come from. Building the payload ourselves lets us lock the amount
 * and stamp the order code as the bill reference, so the screenshot an admin
 * reviews already carries the number they need to match it against.
 *
 * The payload is a series of TLV blocks: a 2-digit id, a 2-digit length, then
 * the value. Nested templates hold TLV blocks of their own.
 */

/** One TLV block. Length is always zero-padded to two digits. */
function tlv(id, value) {
  const str = String(value);
  const len = String(str.length).padStart(2, '0');
  if (str.length > 99) {
    throw new Error(`PayNow field ${id} is too long (${str.length} chars)`);
  }
  return `${id}${len}${str}`;
}

/**
 * CRC-16/CCITT-FALSE - poly 0x1021, init 0xFFFF, no reflection, no final xor.
 * The EMVCo spec computes it across the whole payload including the "6304"
 * header of the CRC field itself.
 */
export function crc16(input) {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Strip anything the spec will not accept in a merchant/reference field. */
function sanitiseRef(value, max = 25) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9\- ]/g, '')
    .trim()
    .slice(0, max);
}

/** "+65 9123 4567" -> "+6591234567"; a bare 8-digit local number gets +65. */
function normaliseMobile(value) {
  const digits = String(value).replace(/[^\d]/g, '');
  if (digits.length === 8) return `+65${digits}`;
  if (digits.startsWith('65') && digits.length === 10) return `+${digits}`;
  return `+${digits}`;
}

/**
 * Build the raw PayNow payload string.
 *
 * @param {object}  opts
 * @param {number}  opts.amountCents  amount in cents; omit for an open QR
 * @param {string}  opts.reference    bill number shown to the payer (order code)
 * @param {Date}    [opts.expiresAt]  QR expiry
 */
export function buildPayNowPayload({ amountCents, reference, expiresAt } = {}) {
  const { proxyType, proxyValue, merchantName, amountEditable } = config.paynow;
  if (!proxyValue) {
    throw new Error('PAYNOW_PROXY_VALUE is not configured');
  }

  const isUen = proxyType.toLowerCase() === 'uen';
  const proxy = isUen ? String(proxyValue).toUpperCase().trim() : normaliseMobile(proxyValue);

  // Tag 26 - the PayNow merchant account template.
  let account =
    tlv('00', 'SG.PAYNOW') +
    tlv('01', isUen ? '2' : '0') +
    tlv('02', proxy) +
    tlv('03', amountEditable ? '1' : '0');

  if (expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())) {
    const y = expiresAt.getFullYear();
    const m = String(expiresAt.getMonth() + 1).padStart(2, '0');
    const d = String(expiresAt.getDate()).padStart(2, '0');
    account += tlv('04', `${y}${m}${d}`);
  }

  let payload =
    tlv('00', '01') +                                   // payload format indicator
    tlv('01', amountCents ? '12' : '11') +              // 12 = dynamic / single use
    tlv('26', account) +
    tlv('52', '0000') +                                 // merchant category code
    tlv('53', '702');                                   // SGD

  if (amountCents && amountCents > 0) {
    payload += tlv('54', (amountCents / 100).toFixed(2));
  }

  payload +=
    tlv('58', 'SG') +
    tlv('59', sanitiseRef(merchantName) || 'NA') +
    tlv('60', 'Singapore');

  const ref = sanitiseRef(reference);
  if (ref) {
    payload += tlv('62', tlv('01', ref));               // additional data -> bill number
  }

  // CRC is calculated over everything up to and including "6304".
  const withCrcHeader = `${payload}6304`;
  return `${withCrcHeader}${crc16(withCrcHeader)}`;
}

/** True when a real PayNow proxy is configured and we can mint dynamic QRs. */
export function isDynamicQrAvailable() {
  return Boolean(config.paynow.proxyValue);
}

/**
 * Produce everything the checkout screen needs to show a QR.
 * Falls back to the static poster QR when no proxy is configured, so the shop
 * still works on day one with nothing but the image from the Google Form.
 */
export async function createPaymentQr({ amountCents, reference, expiresAt }) {
  if (!isDynamicQrAvailable()) {
    return {
      mode: 'static',
      imageUrl: config.paynow.staticQrPath,
      payload: null,
      amountEditable: true,
      note: 'Enter the exact amount and use the order code as the reference.',
    };
  }

  const payload = buildPayNowPayload({ amountCents, reference, expiresAt });
  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#7B1E7A', light: '#FFFFFF' },   // PayNow purple, like the poster
  });

  return {
    mode: 'dynamic',
    imageUrl: dataUrl,
    payload,
    amountEditable: config.paynow.amountEditable,
    note: config.paynow.amountEditable
      ? 'Check the amount before you confirm in your bank app.'
      : 'The amount is locked, so just confirm in your bank app.',
  };
}

export default { buildPayNowPayload, createPaymentQr, crc16, isDynamicQrAvailable };
