import { createRoomServer } from './app.js';
const app = createRoomServer({ database: process.env.DATABASE_PATH ?? 'data/margin.sqlite', staticDir: 'dist', publicOrigin: process.env.PUBLIC_ORIGIN });
const port = Number(process.env.PORT ?? '3044');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
await app.listen(port, process.env.HOST ?? '127.0.0.1');
console.log(`Margin listening on port ${port}.`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!closing) { closing = true; void app.close().then(() => process.exit(0)); } });
