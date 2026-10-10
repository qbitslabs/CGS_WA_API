import assert from 'node:assert/strict';
import test from 'node:test';
import { MetaWhatsAppClient, buildMetaTemplatePayload, buildReadReceiptPayload, isCustomerCareWindowClosed } from './meta.service.ts';

test('read receipt marks the inbound WhatsApp id as seen', () => {
  assert.deepEqual(buildReadReceiptPayload('wamid.abc'), {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: 'wamid.abc',
  });
});

test('template payload uses type template and body parameters', () => {
  const payload = buildMetaTemplatePayload({
    recipientPhone: '+91 98765 43210',
    templateName: 'cgs_missed_appointment',
    languageCode: 'en',
    bodyParameters: ['Ana', 'City Clinic', 'Dr. Shah', '06 Oct 2026', '4:00 pm'],
  });
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'cgs_missed_appointment');
  assert.equal(payload.template.language.code, 'en');
  assert.deepEqual(
    payload.template.components[0].parameters.map((item) => item.text),
    ['Ana', 'City Clinic', 'Dr. Shah', '06 Oct 2026', '4:00 pm']
  );
  assert.equal(isCustomerCareWindowClosed(131047, ''), true);
  assert.equal(isCustomerCareWindowClosed(131026, 'Message undeliverable'), false);
});

test('bill template payload places the media id in the document header', () => {
  const payload = buildMetaTemplatePayload({
    recipientPhone: '919876543210',
    templateName: 'cgs_invoice_bill',
    languageCode: 'en',
    bodyParameters: ['Riya Sharma', 'City Clinic', 'INV-2026-0001', 'Rs. 1,200'],
    document: { mediaId: 'media-123', filename: 'Invoice-INV-2026-0001.pdf' },
  });
  assert.deepEqual(payload.template.components[0], {
    type: 'header',
    parameters: [
      {
        type: 'document',
        document: { id: 'media-123', filename: 'Invoice-INV-2026-0001.pdf' },
      },
    ],
  });
  assert.deepEqual(
    payload.template.components[1].parameters.map((item) => item.text),
    ['Riya Sharma', 'City Clinic', 'INV-2026-0001', 'Rs. 1,200']
  );
});

test('bill send uploads the pdf before the template and uses the returned media id', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith('/media')) {
      return new Response(JSON.stringify({ id: 'media-123' }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.type, 'template');
    assert.equal(body.template.components[0].parameters[0].document.id, 'media-123');
    assert.equal(body.template.components[0].parameters[0].document.filename, 'Invoice-1.pdf');
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const client = new MetaWhatsAppClient();
    const result = await client.sendTemplateMessage({
      phoneNumberId: 'phone-1',
      recipientPhone: '919876543210',
      accessToken: 'token',
      templateName: 'cgs_invoice_bill',
      languageCode: 'en',
      bodyParameters: ['Riya Sharma', 'City Clinic', 'INV-1', 'Rs. 500'],
      document: {
        filename: 'Invoice-1.pdf',
        mimeType: 'application/pdf',
        fileBytes: Buffer.from('%PDF-1.4'),
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].endsWith('/media'), true);
    assert.equal(calls[1].endsWith('/messages'), true);
    assert.equal(result.mediaId, 'media-123');
    assert.equal(result.messages?.[0]?.id, 'wamid.1');
  } finally {
    globalThis.fetch = original;
  }
});
