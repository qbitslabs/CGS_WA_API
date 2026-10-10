/* Meta Cloud API client: send/receive WhatsApp payloads.
 * Transport only; booking logic lives in the AI service. */
export function isCustomerCareWindowClosed(metaCode?: number, message?: string): boolean {
  if (metaCode === 131047 || metaCode === 470) return true;
  const text = (message || '').toLowerCase();
  return text.includes('re-engagement') || text.includes('24 hour') || text.includes('24-hour') || text.includes('customer care window');
}

export function buildMetaTemplatePayload(params: {
  recipientPhone: string;
  templateName: string;
  languageCode: string;
  bodyParameters: string[];
  document?: { mediaId: string; filename: string };
}) {
  const components: Array<{
    type: 'header' | 'body';
    parameters: Array<{ type: string; text?: string; document?: { id: string; filename: string } }>;
  }> = [];
  if (params.document?.mediaId) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'document',
          document: {
            id: params.document.mediaId,
            filename: params.document.filename,
          },
        },
      ],
    });
  }
  components.push({
    type: 'body',
    parameters: params.bodyParameters.map((text) => ({ type: 'text', text })),
  });
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.recipientPhone.replace(/\D/g, ''),
    type: 'template' as const,
    template: {
      name: params.templateName,
      language: { code: params.languageCode },
      components,
    },
  };
}

export function buildReadReceiptPayload(messageId: string) {
  return {
    messaging_product: 'whatsapp' as const,
    status: 'read' as const,
    message_id: messageId,
  };
}

export interface OutboundMessageParams {
  phoneNumberId: string;
  recipientPhone: string;
  accessToken: string;
  messageType?: 'text' | 'template';
  text?: string;
  templateName?: string;
  templateLanguage?: string;
}

export class MetaWhatsAppClient {
  private apiVersion: string;

  constructor(apiVersion = 'v20.0') {
    this.apiVersion = process.env.META_GRAPH_API_VERSION || apiVersion;
  }

  private graphUrl(phoneNumberId: string, path: string) {
    const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    return `https://graph.facebook.com/${this.apiVersion}/${phoneId}/${path}`;
  }

  private authJsonHeaders(accessToken: string) {
    const token = accessToken || process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '';
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async markMessageRead(params: { phoneNumberId: string; accessToken: string; messageId: string }) {
    const response = await fetch(this.graphUrl(params.phoneNumberId, 'messages'), {
      method: 'POST',
      headers: this.authJsonHeaders(params.accessToken),
      body: JSON.stringify(buildReadReceiptPayload(params.messageId)),
    });
    const data = (await response.json()) as { error?: { message?: string; code?: number } };
    if (!response.ok) {
      const error = new Error(data.error?.message || `Meta read receipt failed: ${JSON.stringify(data)}`) as Error & {
        metaCode?: number;
      };
      error.metaCode = data.error?.code;
      throw error;
    }
    return data;
  }

  async sendTextMessage(params: {
    phoneNumberId: string;
    recipientPhone: string;
    accessToken: string;
    text: string;
  }) {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.recipientPhone.replace(/\D/g, ''),
      type: 'text',
      text: {
        preview_url: false,
        body: params.text,
      },
    };

    const response = await fetch(this.graphUrl(params.phoneNumberId, 'messages'), {
      method: 'POST',
      headers: this.authJsonHeaders(params.accessToken),
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as { error?: { message?: string; code?: number } };
    if (!response.ok) {
      const error = new Error(data.error?.message || `Meta Cloud API Error: ${JSON.stringify(data)}`) as Error & {
        metaCode?: number;
      };
      error.metaCode = data.error?.code;
      throw error;
    }

    return data;
  }

  async sendTemplateMessage(params: {
    phoneNumberId: string;
    recipientPhone: string;
    accessToken: string;
    templateName: string;
    languageCode: string;
    bodyParameters: string[];
    document?: { filename: string; mimeType: string; fileBytes: Buffer };
  }) {
    let document: { mediaId: string; filename: string } | undefined;
    if (params.document) {
      const mediaId = await this.uploadMedia(
        params.phoneNumberId,
        params.accessToken,
        params.document.filename,
        params.document.mimeType || 'application/pdf',
        params.document.fileBytes
      );
      document = { mediaId, filename: params.document.filename };
    }
    const body = buildMetaTemplatePayload({
      recipientPhone: params.recipientPhone,
      templateName: params.templateName,
      languageCode: params.languageCode,
      bodyParameters: params.bodyParameters,
      document,
    });
    const response = await fetch(this.graphUrl(params.phoneNumberId, 'messages'), {
      method: 'POST',
      headers: this.authJsonHeaders(params.accessToken),
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as { error?: { message?: string; code?: number }; messages?: Array<{ id?: string }> };
    if (!response.ok) {
      const error = new Error(data.error?.message || `Meta Cloud API Error: ${JSON.stringify(data)}`) as Error & {
        metaCode?: number;
      };
      error.metaCode = data.error?.code;
      throw error;
    }
    return { ...data, mediaId: document?.mediaId };
  }

  async sendDocumentMessage(params: {
    phoneNumberId: string;
    recipientPhone: string;
    accessToken: string;
    caption: string;
    filename: string;
    mimeType: string;
    fileBytes: Buffer;
  }) {
    const mediaId = await this.uploadMedia(
      params.phoneNumberId,
      params.accessToken,
      params.filename,
      params.mimeType,
      params.fileBytes
    );
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.recipientPhone.replace(/\D/g, ''),
      type: 'document',
      document: {
        id: mediaId,
        filename: params.filename,
        caption: params.caption.slice(0, 1024),
      },
    };

    const response = await fetch(this.graphUrl(params.phoneNumberId, 'messages'), {
      method: 'POST',
      headers: this.authJsonHeaders(params.accessToken),
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as { error?: { message?: string; code?: number } };
    if (!response.ok) {
      const error = new Error(data.error?.message || `Meta Cloud API Error: ${JSON.stringify(data)}`) as Error & {
        metaCode?: number;
      };
      error.metaCode = data.error?.code;
      throw error;
    }

    return data;
  }

  private async uploadMedia(
    phoneNumberId: string,
    accessToken: string,
    filename: string,
    mimeType: string,
    fileBytes: Buffer
  ): Promise<string> {
    const token = accessToken || process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '';
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType || 'application/pdf');
    form.append(
      'file',
      new Blob([new Uint8Array(fileBytes)], { type: mimeType || 'application/pdf' }),
      filename
    );

    const response = await fetch(this.graphUrl(phoneNumberId, 'media'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    });

    const data = (await response.json()) as { id?: string };
    if (!response.ok || !data.id) {
      throw new Error(`Meta media upload failed: ${JSON.stringify(data)}`);
    }
    return data.id;
  }
}
