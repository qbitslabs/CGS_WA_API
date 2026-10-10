/* Outbound WhatsApp send API used by CGS after AI replies.
 * Posts the already-guarded patient text to Meta Cloud API. */
import { Request, Response } from 'express';
import { z } from 'zod';
import { isCustomerCareWindowClosed, MetaWhatsAppClient } from '../services/meta.service.js';

const client = new MetaWhatsAppClient();

function internalSecret(): string {
  return process.env.INTERNAL_SERVICE_SECRET || '';
}

export const markWhatsAppRead = async (req: Request, res: Response): Promise<void> => {
  const serviceKey = req.headers['x-service-key'];
  const expected = internalSecret();
  if (!expected || !serviceKey || serviceKey !== expected) {
    res.status(401).json({ success: false, error: 'Unauthorized internal service call' });
    return;
  }

  try {
    const data = z
      .object({
        phoneNumberId: z.string().min(1),
        accessToken: z.string().min(1),
        messageId: z.string().min(1),
      })
      .parse(req.body);
    await client.markMessageRead(data);
    res.json({ success: true });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      error: error.message || 'Failed to mark the WhatsApp message as read',
    });
  }
};

export const sendWhatsAppMessage = async (req: Request, res: Response): Promise<void> => {
  const serviceKey = req.headers['x-service-key'];
  const expected = internalSecret();
  if (!expected || !serviceKey || serviceKey !== expected) {
    res.status(401).json({ success: false, error: 'Unauthorized internal service call' });
    return;
  }

  try {
    const schema = z.object({
      phoneNumberId: z.string().min(1),
      recipientPhone: z.string().min(5),
      accessToken: z.string().min(1),
      text: z.string().min(1).optional(),
      template: z
        .object({
          name: z.string().min(1),
          languageCode: z.string().min(2),
          bodyParameters: z.array(z.string()),
          document: z
            .object({
              filename: z.string().min(1),
              mimeType: z.string().optional(),
              base64: z.string().min(1),
            })
            .optional(),
        })
        .optional(),
      document: z
        .object({
          filename: z.string().min(1),
          mimeType: z.string().optional(),
          base64: z.string().min(1),
        })
        .optional(),
    }).refine((value) => Boolean(value.text || value.template), {
      message: 'text or template is required',
    });

    const data = schema.parse(req.body);

    const result = data.template
      ? await client.sendTemplateMessage({
          phoneNumberId: data.phoneNumberId,
          recipientPhone: data.recipientPhone,
          accessToken: data.accessToken,
          templateName: data.template.name,
          languageCode: data.template.languageCode,
          bodyParameters: data.template.bodyParameters,
          document: data.template.document
            ? {
                filename: data.template.document.filename,
                mimeType: data.template.document.mimeType || 'application/pdf',
                fileBytes: Buffer.from(data.template.document.base64, 'base64'),
              }
            : undefined,
        })
      : data.document
      ? await client.sendDocumentMessage({
          phoneNumberId: data.phoneNumberId,
          recipientPhone: data.recipientPhone,
          accessToken: data.accessToken,
          caption: data.text || '',
          filename: data.document.filename,
          mimeType: data.document.mimeType || 'application/pdf',
          fileBytes: Buffer.from(data.document.base64, 'base64'),
        })
      : await client.sendTextMessage({
          phoneNumberId: data.phoneNumberId,
          recipientPhone: data.recipientPhone,
          accessToken: data.accessToken,
          text: data.text || '',
        });

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    const metaCode = typeof error?.metaCode === 'number' ? error.metaCode : undefined;
    const message = error.message || 'Failed to dispatch WhatsApp message via Meta Cloud API';
    res.status(502).json({
      success: false,
      error: message,
      metaCode,
      windowClosed: isCustomerCareWindowClosed(metaCode, message),
    });
  }
};
