import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { stableProviderEventId, verifySignature } from './webhook.controller.ts';

test('stable event ids ignore delivery time so Meta retries stay idempotent', () => {
  const value = { messages: [{ id: 'wamid.1' }, { id: 'wamid.2' }] };
  const first = stableProviderEventId('entry-1', 'messages', value);
  const second = stableProviderEventId('entry-1', 'messages', value);
  assert.equal(first, second);
  assert.equal(first, 'entry-1:messages:wamid.1,wamid.2');
  assert.notEqual(stableProviderEventId('entry-1', 'messages', { messages: [{ id: 'wamid.3' }] }), first);
});

test('signature verification rejects a bad digest when the app secret is set', () => {
  process.env.META_APP_SECRET = 'test-meta-secret';
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const good = crypto.createHmac('sha256', 'test-meta-secret').update(body).digest('hex');
  assert.equal(verifySignature(body, `sha256=${good}`), true);
  assert.equal(verifySignature(body, 'sha256=deadbeef'), false);
  assert.equal(verifySignature(body, undefined), false);
  delete process.env.META_APP_SECRET;
});

test('missing app secret does not invent a signature check', () => {
  delete process.env.META_APP_SECRET;
  delete process.env.WHATSAPP_APP_SECRET;
  assert.equal(verifySignature(Buffer.from('{}'), undefined), true);
});
