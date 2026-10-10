/* Meta webhook receiver for inbound WhatsApp patient messages.
 * Records the event in CGS before acknowledging Meta, and ignores duplicate ids. */
import { Request, Response } from 'express';
import crypto from 'crypto';

const CGS_BACKEND_URL = process.env.CGS_MAIN_BACKEND_URL || 'http://localhost:4000';

function internalSecret(): string {
  return process.env.INTERNAL_SERVICE_SECRET || '';
}

function verifyToken(): string {
  return process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
}

export function verifySignature(rawBody: Buffer | undefined, signatureHeader?: string): boolean {
  const secret = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || '';
  if (!secret) return true;
  if (!signatureHeader || !rawBody) return false;
  try {
    const [algo, sig] = signatureHeader.split('=');
    if (algo !== 'sha256' || !sig) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const actual = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (actual.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(actual, expectedBuf);
  } catch {
    return false;
  }
}

export function stableProviderEventId(entryId: string, field: string, value: any): string {
  const messageIds = (value?.messages || []).map((message: { id?: string }) => message.id).filter(Boolean);
  const statusIds = (value?.statuses || []).map(
    (status: { id?: string; status?: string; timestamp?: string }) =>
      `${status.id || ''}:${status.status || ''}:${status.timestamp || ''}`
  );
  const ids = [...messageIds, ...statusIds];
  if (ids.length) return `${entryId}:${field}:${ids.join(',')}`;
  const digest = crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex').slice(0, 32);
  return `${entryId}:${field}:${digest}`;
}

type ForwardResult = { ok: boolean; status: number };

async function forwardToCgs(path: string, body: unknown): Promise<ForwardResult> {
  const secret = internalSecret();
  if (!secret) {
    console.error('[WhatsApp Gateway] INTERNAL_SERVICE_SECRET is not configured.');
    return { ok: false, status: 500 };
  }

  const response = await fetch(`${CGS_BACKEND_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Key': secret,
    },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status };
}

export const verifyWebhook = (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = verifyToken();

  if (mode && token) {
    if (expected && mode === 'subscribe' && token === expected) {
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

const inFlightEvents = new Map<string, Promise<boolean>>();

async function acceptEvent(providerEventId: string, work: () => Promise<boolean>): Promise<boolean> {
  const existing = inFlightEvents.get(providerEventId);
  if (existing) return existing;

  const run = work().finally(() => {
    inFlightEvents.delete(providerEventId);
  });
  inFlightEvents.set(providerEventId, run);
  return run;
}

export const processWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!verifySignature(rawBody, signature)) {
    console.warn('[WhatsApp Gateway] Invalid X-Hub-Signature-256 received, rejecting webhook payload.');
    res.status(401).json({ error: 'INVALID_SIGNATURE' });
    return;
  }

  const body = req.body;
  if (!body || body.object !== 'whatsapp_business_account') {
    res.status(200).json({ status: 'IGNORED' });
    return;
  }

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const providerEventId = stableProviderEventId(String(entry.id || 'entry'), change.field || 'messages', value);

        const recorded = await acceptEvent(providerEventId, async () => {
          const eventResult = await forwardToCgs('/cgs_api/v1/internal/whatsapp/event', {
            providerEventId,
            phoneNumberId: phoneNumberId || 'UNKNOWN',
            eventType: change.field || 'messages',
            payload: body,
          });
          if (!eventResult.ok && eventResult.status !== 409) return false;

          if (value.messages && value.messages.length > 0) {
            const contact = value.contacts?.[0];
            const senderName = contact?.profile?.name || 'Patient';
            for (const msg of value.messages) {
              let content = '';
              if (msg.type === 'text') content = msg.text?.body || '';
              else if (msg.type === 'button') content = msg.button?.text || '';
              else if (msg.type === 'interactive') {
                content = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
              } else content = `[Media: ${msg.type}]`;

              const messageResult = await forwardToCgs('/cgs_api/v1/internal/whatsapp/inbound-message', {
                phoneNumberId,
                senderPhone: msg.from,
                senderName,
                content,
                providerMessageId: msg.id,
              });
              if (!messageResult.ok && messageResult.status !== 409) return false;
            }
          }
          return true;
        });

        if (!recorded) {
          res.status(503).json({ error: 'EVENT_NOT_RECORDED' });
          return;
        }
      }
    }

    res.status(200).json({ status: 'EVENT_RECEIVED' });
  } catch (error: any) {
    console.error('[WhatsApp Gateway] Exception processing webhook payload:', error.message);
    if (!res.headersSent) {
      res.status(503).json({ error: 'EVENT_NOT_RECORDED' });
    }
  }
};
