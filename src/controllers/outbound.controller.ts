/* Outbound WhatsApp send API used by CGS after AI replies.
 * Posts the already-guarded patient text to Meta Cloud API. */
import { Request, Response } from 'express';
import { z } from 'zod';
import { MetaWhatsAppClient } from '../services/meta.service.js';

const client = new MetaWhatsAppClient();
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'cgs-internal-service-secret-key-998877';

export const sendWhatsAppMessage = async (req: Request, res: Response): Promise<void> => {
  const serviceKey = req.headers['x-service-key'];
  if (!serviceKey || serviceKey !== INTERNAL_SECRET) {
    res.status(401).json({ success: false, error: 'Unauthorized internal service call' });
    return;
  }

  try {
    const schema = z.object({
      phoneNumberId: z.string().min(1),
      recipientPhone: z.string().min(5),
      accessToken: z.string().min(1),
      text: z.string().min(1),
      document: z
        .object({
          filename: z.string().min(1),
          mimeType: z.string().optional(),
          base64: z.string().min(1),
        })
        .optional(),
    });

    const data = schema.parse(req.body);

    const result = data.document
      ? await client.sendDocumentMessage({
          phoneNumberId: data.phoneNumberId,
          recipientPhone: data.recipientPhone,
          accessToken: data.accessToken,
          caption: data.text,
          filename: data.document.filename,
          mimeType: data.document.mimeType || 'application/pdf',
          fileBytes: Buffer.from(data.document.base64, 'base64'),
        })
      : await client.sendTextMessage(data);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to dispatch WhatsApp message via Meta Cloud API',
    });
  }
};
