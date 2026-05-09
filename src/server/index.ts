import { ensureStorageDirs, serverConfig } from './config.js';
import { createApp } from './app.js';

await ensureStorageDirs();
const app = await createApp();

app.listen(serverConfig.port, () => {
  console.log(`OneFolder Web listening on http://localhost:${serverConfig.port}`);
});
