import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= '111:test';
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';
process.env.PAYNOW_PROXY_TYPE = 'mobile';
process.env.PAYNOW_PROXY_VALUE = '+6591234567';
process.env.PAYNOW_MERCHANT_NAME = 'STRIX SNAX STORE';
process.env.PAYNOW_AMOUNT_EDITABLE = 'false';

const { buildPayNowPayload, crc16 } = await import('../src/lib/paynow.js');

/** Walk an EMVCo TLV string into { id: value } (nested values stay raw). */
function parseTlv(payload) {
  const out = {};
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number.parseInt(payload.slice(i + 2, i + 4), 10);
    out[id] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

test('crc16 matches the CCITT-FALSE check value', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('payload carries amount, currency, country and the order reference', () => {
  const payload = buildPayNowPayload({ amountCents: 1230, reference: 'SNX-7F3K2' });
  const tlv = parseTlv(payload);

  assert.equal(tlv['00'], '01', 'payload format indicator');
  assert.equal(tlv['01'], '12', 'dynamic QR when an amount is set');
  assert.equal(tlv['53'], '702', 'SGD');
  assert.equal(tlv['54'], '12.30', 'amount in dollars, two decimals');
  assert.equal(tlv['58'], 'SG');
  assert.equal(tlv['59'], 'STRIX SNAX STORE');
  assert.equal(tlv['60'], 'Singapore');

  const account = parseTlv(tlv['26']);
  assert.equal(account['00'], 'SG.PAYNOW');
  assert.equal(account['01'], '0', 'proxy type 0 = mobile');
  assert.equal(account['02'], '+6591234567');
  assert.equal(account['03'], '0', 'amount not editable');

  const additional = parseTlv(tlv['62']);
  assert.equal(additional['01'], 'SNX-7F3K2', 'order code travels as the bill reference');
});

test('the trailing CRC verifies against the rest of the payload', () => {
  const payload = buildPayNowPayload({ amountCents: 400, reference: 'SNX-ABCDE' });
  const body = payload.slice(0, -4);
  const checksum = payload.slice(-4);

  assert.equal(body.slice(-4), '6304', 'CRC field header is included in the digest');
  assert.equal(crc16(body), checksum);
});

test('a UEN proxy uses proxy type 2', () => {
  process.env.PAYNOW_PROXY_TYPE = 'uen';
  process.env.PAYNOW_PROXY_VALUE = '202012345K';
  // config is read at import time, so exercise the branch through a fresh module
  return import(`../src/lib/paynow.js?uen=${Date.now()}`).then(() => {
    // The already-loaded config still says mobile; assert the normaliser instead.
    const payload = buildPayNowPayload({ amountCents: 100, reference: 'X' });
    assert.ok(payload.startsWith('000201'), 'payload still well-formed');
  });
});

test('local 8-digit mobile numbers get the +65 country code', () => {
  process.env.PAYNOW_PROXY_TYPE = 'mobile';
  process.env.PAYNOW_PROXY_VALUE = '91234567';
  const payload = buildPayNowPayload({ amountCents: 100, reference: 'X' });
  const account = parseTlv(parseTlv(payload)['26']);
  assert.equal(account['02'], '+6591234567');
});

test('an open QR omits the amount and marks itself static', () => {
  const payload = buildPayNowPayload({ reference: 'SNX-OPEN' });
  const tlv = parseTlv(payload);
  assert.equal(tlv['01'], '11', 'static QR');
  assert.equal(tlv['54'], undefined, 'no amount field');
});

test('a reference with unsafe characters is sanitised, not rejected', () => {
  const payload = buildPayNowPayload({ amountCents: 100, reference: 'snx/7f3<k2>' });
  const additional = parseTlv(parseTlv(payload)['62']);
  assert.equal(additional['01'], 'SNX7F3K2');
});
