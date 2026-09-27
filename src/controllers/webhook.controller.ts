/* Meta webhook receiver for inbound WhatsApp patient messages.
 * Forwards text to CGS/AI; never returns tool names to the phone. */
import { Request, Response } from 'express';
import crypto from 'crypto';

const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'cgs_meta_webhook_verify_token_2026';
const META_APP_SECRET = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || '';
const CGS_BACKEND_URL = process.env.CGS_MAIN_BACKEND_URL || 'http://localhost:4000';
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'cgs-internal-service-secret-key-998877';

export const verifySignature = (rawBody: any, signatureHeader?: string): boolean => {
  if (!META_APP_SECRET || !signatureHeader) return true;
  try {
    const [algo, sig] = signatureHeader.split('=');
    if (algo !== 'sha256' || !sig) return false;
    const hmac = crypto.createHmac('sha256', META_APP_SECRET);
    const payload = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    const expected = hmac.update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
};

// GET /api/v1/webhooks/whatsapp (Meta Hub Challenge Verification)
export const verifyWebhook = (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[WhatsApp Gateway] Webhook challenge verified successfully with Meta.');
      res.status(200).send(challenge);
      return;
    }
    console.warn('[WhatsApp Gateway] Webhook verification token mismatch.');
    res.sendStatus(403);
    return;
  }

  res.sendStatus(400);
};

// POST /api/v1/webhooks/whatsapp (Inbound Webhook Payload Processing)
export const processWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (!verifySignature(req.body, signature)) {
    console.warn('[WhatsApp Gateway] Invalid X-Hub-Signature-256 received, rejecting webhook payload.');
    res.status(401).json({ error: 'INVALID_SIGNATURE' });
    return;
  }

  // Return HTTP 200 OK immediately to satisfy Meta's <2s SLA
  res.status(200).json({ status: 'EVENT_RECEIVED' });

  const body = req.body;
  if (!body || body.object !== 'whatsapp_business_account') {
    return;
  }

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const providerEventId = `${entry.id}_${change.field}_${Date.now()}`;

        // 1. Ingest Raw Webhook Event into CGS_Backend
        try {
          await fetch(`${CGS_BACKEND_URL}/cgs_api/v1/internal/whatsapp/event`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Service-Key': INTERNAL_SECRET,
            },
            body: JSON.stringify({
              providerEventId,
              phoneNumberId: phoneNumberId || 'UNKNOWN',
              eventType: change.field || 'messages',
              payload: body,
            }),
          });
        } catch (err: any) {
          console.error('[WhatsApp Gateway] Failed to persist raw event in CGS backend:', err.message);
        }

        // 2. Parse and Ingest Inbound Messages
        if (value.messages && value.messages.length > 0) {
          const contact = value.contacts?.[0];
          const senderName = contact?.profile?.name || 'Patient';

          for (const msg of value.messages) {
            const senderPhone = msg.from;
            const providerMessageId = msg.id;
            const messageType = msg.type;

            let content = '';
            if (messageType === 'text') {
              content = msg.text?.body || '';
            } else if (messageType === 'button') {
              content = msg.button?.text || '';
            } else if (messageType === 'interactive') {
              content = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
            } else {
              content = `[Media: ${messageType}]`;
            }

            try {
              await fetch(`${CGS_BACKEND_URL}/cgs_api/v1/internal/whatsapp/inbound-message`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Service-Key': INTERNAL_SECRET,
                },
                body: JSON.stringify({
                  phoneNumberId,
                  senderPhone,
                  senderName,
                  content,
                  providerMessageId,
                }),
              });
              console.log(`[WhatsApp Gateway] Forwarded message ${providerMessageId} from ${senderPhone} to CGS`);
            } catch (err: any) {
              console.error('[WhatsApp Gateway] Failed to forward message to CGS backend:', err.message);
            }
          }
        }
      }
    }
  } catch (error: any) {
    console.error('[WhatsApp Gateway] Exception processing webhook payload:', error.message);
  }
};
