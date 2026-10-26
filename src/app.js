import express from 'express';
import { createRateLimiter } from './rate-limiter.js';

export function createApp(config, options) {
  const app = express();
  // Matching semantics are explicit; endpoint policies must agree with these.
  app.disable('case sensitive routing');
  app.disable('strict routing');
  app.disable('x-powered-by');
  const limiter = createRateLimiter(config, options);
  app.use((req, res, next) => {
    // Demo identity only. Replace with identity supplied by verified authentication.
    req.orgId = req.get('X-Org-Id');
    next();
  });
  app.use(limiter.middleware);
  app.use(express.json({ limit: '16kb' }));
  app.get('/items', (req, res) => res.json({ items: [] }));
  app.post('/items', (req, res) => res.status(201).json({ message: 'Demo write accepted; nothing persisted.' }));
  app.put('/items', (req, res) => res.json({ message: 'Demo update accepted.' }));
  app.patch('/items', (req, res) => res.json({ message: 'Demo patch accepted.' }));
  app.delete('/items', (req, res) => res.status(204).end());
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  return { app, limiter };
}
