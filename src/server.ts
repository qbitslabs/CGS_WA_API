/* HTTP entry for the WhatsApp worker service.
 * Webhook + outbound routes that sit between Meta and CGS. */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { verifyWebhook, processWebhook } from './controllers/webhook.controller.js';
import { sendWhatsAppMessage } from './controllers/outbound.controller.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGINS || 'http://localhost:4000,http://localhost:5174').split(',').map((s) => s.trim()),
  credentials: true,
}));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(morgan('dev'));

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'cgs-whatsapp-service', timestamp: new Date().toISOString() });
});

// Meta WhatsApp Webhook endpoints
app.get('/w_api/v1/webhooks/whatsapp', verifyWebhook);
app.post('/w_api/v1/webhooks/whatsapp', processWebhook);

// Outbound Dispatch endpoint (called internally by CGS_Backend)
app.post('/w_api/v1/whatsapp/send', sendWhatsAppMessage);

app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`💬 CGS Dedicated WhatsApp & Webhook Gateway running on port ${PORT}`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/w_api/v1/webhooks/whatsapp`);
  console.log(`================================================================`);
});
