import { createApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig(process.env.CONFIG_PATH ?? new URL('../config.json', import.meta.url));
  const { app, limiter } = createApp(config);
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const cleanup = setInterval(limiter.sweep, 60_000);
  cleanup.unref();
  const server = app.listen(port, '127.0.0.1', () => console.log(`Demo API: http://127.0.0.1:${port}`));
  server.on('error', error => { clearInterval(cleanup); console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(cleanup); server.close(); });
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
}
