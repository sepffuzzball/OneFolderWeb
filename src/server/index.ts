import { ensureStorageDirs, serverConfig } from './config.js';
import { createApp } from './app.js';
import type { OneFolderApp } from './app.js';

await ensureStorageDirs();
const app = await createApp();

const server = app.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`${serverConfig.host}:${serverConfig.port} is serving OneFolder Web`);
});

/**
 * Memoized shutdown procedure for signals: synchronously initiate server.close,
 * await app.stopBackground, await HTTP server close/drain, await app.shutdown,
 * then exit 0. Errors log a generic message and exit 1.
 */
/**
 * Construct/register the server-close promise callback before or as part of
 * invoking server.close, then call app.stopBackground, await server close,
 * and app.shutdown. Do not attach the `close` listener after stopBackground.
 * Generic error logging only.
 */
let shutdownPromise: Promise<void> | undefined;

async function gracefulShutdown(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  // Build the close promise before invoking server.close.
  const serverClosed = new Promise<void>((resolve) => {
    server.once('close', resolve);
  });

  shutdownPromise = (async () => {
    // Synchronously initiate server close.
    server.close();

    // Await app background stop.
    await app.stopBackground();

    // Await HTTP server close/drain.
    await serverClosed;

    // Await app shutdown.
    await app.shutdown();

    // Exit 0 on success.
    process.exit(0);
  })();

  return shutdownPromise;
}

process.once('SIGINT', () => void gracefulShutdown().catch((err) => {
  console.error('Error during shutdown:', err);
  process.exit(1);
}));
process.once('SIGTERM', () => void gracefulShutdown().catch((err) => {
  console.error('Error during shutdown:', err);
  process.exit(1);
}));
