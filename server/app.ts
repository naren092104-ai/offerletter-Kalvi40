import express, { type NextFunction, type Request, type Response } from 'express';
import { createApiRouter } from './routes-supabase.ts';

const BODY_LIMIT_BYTES = 15 * 1024 * 1024;

function parseRequestBody(req: Request, res: Response, next: NextFunction): void {
  const contentType = req.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  const isJson = contentType === 'application/json' || Boolean(contentType?.endsWith('+json'));
  const isForm = contentType === 'application/x-www-form-urlencoded';
  if (!isJson && !isForm) {
    next();
    return;
  }

  const contentLength = Number(req.get('Content-Length') || 0);
  if (contentLength > BODY_LIMIT_BYTES) {
    res.status(413).json({ error: 'Request body exceeds the 15 MB limit.' });
    req.resume();
    return;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let finished = false;
  req.on('data', (chunk: Buffer | string) => {
    if (finished) return;
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > BODY_LIMIT_BYTES) {
      finished = true;
      res.status(413).json({ error: 'Request body exceeds the 15 MB limit.' });
      req.resume();
      return;
    }
    chunks.push(bytes);
  });
  req.on('end', () => {
    if (finished) return;
    try {
      const body = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(body);
      if (isJson) {
        req.body = text ? JSON.parse(text) : {};
      } else {
        const form: Record<string, string | string[]> = {};
        for (const [key, value] of new URLSearchParams(text)) {
          const previous = form[key];
          form[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
        }
        req.body = form;
      }
      next();
    } catch {
      res.status(400).json({ error: 'Request body is not valid JSON or URL-encoded data.' });
    }
  });
  req.on('error', (error: Error) => {
    if (!finished) next(error);
  });
}

export function createApiApp(): express.Express {
  const app = express();
  const allowedOrigins = new Set(
    [process.env.APP_URL, process.env.ALLOWED_ORIGIN, ...(process.env.CORS_ORIGINS || '').split(',')]
      .map((origin) => origin?.trim().replace(/\/$/, ''))
      .filter((origin): origin is string => Boolean(origin)),
  );

  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    const originAllowed = Boolean(origin && allowedOrigins.has(origin));

    if (origin && originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(origin && !originAllowed ? 403 : 204);
      return;
    }

    next();
  });
  app.use(parseRequestBody);
  app.use('/api', createApiRouter());

  return app;
}