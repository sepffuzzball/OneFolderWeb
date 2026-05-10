import { ensureStorageDirs, serverConfig } from './config.js';
import { createApp } from './app.js';

await ensureStorageDirs();
const app = await createApp();

app.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`${serverConfig.host}:${serverConfig.port} is serving OneFolder Web`);
});
