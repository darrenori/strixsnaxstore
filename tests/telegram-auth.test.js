import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BOT_TOKEN = '8900764054:TEST-TOKEN-FOR-UNIT-TESTS-ONLY';

process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/testdb';


const { verifyInitData, InitDataError } = await import('../src/lib/telegram-auth.js');

/** Produce initData exactly the way Telegram does, so the test is meaningful. */
function signInitData(fields, token = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const validUser = { id: 12345, first_name: 'Darren', username: 'darren', language_code: 'en' };

function freshInitData(overrides = {}, token = BOT_TOKEN) {
  return signInitData({
    user: JSON.stringify(validUser),
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH-test',
    ...overrides,
  }, token);
}

test('accepts init data Telegram actually signed', () => {
  const result = verifyInitData(freshInitData());
  assert.equal(result.user.id, 12345);
  assert.equal(result.user.username, 'darren');
  assert.equal(result.user.firstName, 'Darren');
  assert.equal(result.queryId, 'AAH-test');
});

test('rejects a tampered user id even though the rest is untouched', () => {
  const initData = freshInitData();
  const params = new URLSearchParams(initData);
  // The classic attack: swap yourself for the admin, keep the signature.
  params.set('user', JSON.stringify({ ...validUser, id: 999999 }));

  assert.throws(() => verifyInitData(params.toString()), InitDataError);
});

test('rejects a hash signed with a different bot token', () => {
  const forged = freshInitData({}, '8900764054:SOME-OTHER-TOKEN');
  assert.throws(() => verifyInitData(forged), InitDataError);
});

test('rejects init data with no hash at all', () => {
  const params = new URLSearchParams({
    user: JSON.stringify(validUser),
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
  assert.throws(() => verifyInitData(params.toString()), /no hash/);
});

test('rejects a replayed session older than the max age', () => {
  const old = freshInitData({ auth_date: String(Math.floor(Date.now() / 1000) - 60 * 60 * 48) });
  assert.throws(() => verifyInitData(old), (err) => err.code === 'INIT_DATA_EXPIRED');
});

test('honours a shorter max age when one is passed', () => {
  const tenMinutesAgo = freshInitData({ auth_date: String(Math.floor(Date.now() / 1000) - 600) });
  assert.ok(verifyInitData(tenMinutesAgo), 'valid under the default 24h window');
  assert.throws(() => verifyInitData(tenMinutesAgo, { maxAgeSeconds: 300 }),
    (err) => err.code === 'INIT_DATA_EXPIRED');
});

test('rejects an auth_date far in the future', () => {
  const future = freshInitData({ auth_date: String(Math.floor(Date.now() / 1000) + 3600) });
  assert.throws(() => verifyInitData(future), /future/);
});

test('rejects empty and oversized input', () => {
  assert.throws(() => verifyInitData(''), (err) => err.code === 'MISSING_INIT_DATA');
  assert.throws(() => verifyInitData(null), (err) => err.code === 'MISSING_INIT_DATA');
  assert.throws(() => verifyInitData('x'.repeat(9000)), (err) => err.code === 'INIT_DATA_TOO_LARGE');
});

test('rejects a signed payload that carries no user', () => {
  const noUser = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH' });
  assert.throws(() => verifyInitData(noUser), /no usable user/);
});

test('rejects a hash of the wrong length without throwing on the compare', () => {
  const params = new URLSearchParams(freshInitData());
  params.set('hash', 'abcd');
  assert.throws(() => verifyInitData(params.toString()), InitDataError);
});

test('a signature stays valid when fields are reordered', () => {
  // data_check_string sorts keys, so transport order must not matter.
  const initData = freshInitData();
  const params = new URLSearchParams(initData);
  const shuffled = new URLSearchParams();
  for (const key of [...params.keys()].reverse()) shuffled.set(key, params.get(key));

  assert.equal(verifyInitData(shuffled.toString()).user.id, 12345);
});

// ---------------------------------------------------------------------------
// The `signature` field newer clients send.
//
// It is an Ed25519 signature for validating without the bot token. The spec
// excludes only `hash` from the data-check-string, but clients have shipped
// both readings, and guessing wrong locks every shopper out of the store.
// ---------------------------------------------------------------------------

/** Sign the way the spec reads: everything but `hash` goes into the digest. */
function signIncludingSignature(fields) {
  return signInitData({ ...fields, signature: 'Ed25519-fake-for-test' });
}

/** Sign the other way: `signature` present, but left out of the digest. */
function signExcludingSignature(fields) {
  const params = new URLSearchParams({
    user: JSON.stringify(validUser),
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...fields,
  });
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  params.set('signature', 'Ed25519-fake-for-test');
  params.set('hash', hash);
  return params.toString();
}

test('accepts init data whose digest covers the signature field', () => {
  const result = verifyInitData(signIncludingSignature({
    user: JSON.stringify(validUser),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }));
  assert.equal(result.user.id, validUser.id);
  assert.equal(result.signatureExcluded, false);
});

test('also accepts init data whose digest leaves the signature field out', () => {
  const result = verifyInitData(signExcludingSignature({}));
  assert.equal(result.user.id, validUser.id);
  assert.equal(result.signatureExcluded, true, 'should report which reading matched');
});

test('a signature field does not let a tampered user through', () => {
  const signed = signExcludingSignature({});
  const tampered = new URLSearchParams(signed);
  tampered.set('user', JSON.stringify({ ...validUser, id: 99999 }));
  assert.throws(() => verifyInitData(tampered.toString()), /does not match/);
});

test('a rejected signature reports which fields arrived, for diagnosis', () => {
  const signed = freshInitData();
  const tampered = new URLSearchParams(signed);
  tampered.set('user', JSON.stringify({ ...validUser, id: 5 }));
  try {
    verifyInitData(tampered.toString());
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.detail, /auth_date/);
    assert.match(err.detail, /user/);
    assert.doesNotMatch(err.detail, /Darren/, 'field names only, never values');
  }
});
