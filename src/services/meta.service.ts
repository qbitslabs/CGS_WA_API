/* Meta Cloud API client: send/receive WhatsApp payloads.
 * Transport only; booking logic lives in the AI service. */
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

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Meta Cloud API Error: ${JSON.stringify(data)}`);
    }

    return data;
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

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Meta Cloud API Error: ${JSON.stringify(data)}`);
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
