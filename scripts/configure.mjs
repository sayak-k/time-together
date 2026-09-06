import { readFile, writeFile, mkdir } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.argv[2] || 'firebase.config.json', 'utf8'));
for (const key of ['apiKey', 'androidApiKey', 'authDomain', 'projectId', 'appId', 'androidAppId']) {
  if (typeof config[key] !== 'string' || !config[key] || /YOUR_|FROM_/.test(config[key])) throw new Error(`Missing ${key}`);
}
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId)) throw new Error('Invalid Firebase project ID');
const webConfig = {
  apiKey: config.apiKey,
  authDomain: config.authDomain,
  projectId: config.projectId,
  appId: config.appId,
  ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}),
  ...(config.messagingSenderId ? { messagingSenderId: config.messagingSenderId } : {}),
};
await writeFile('.env.local', 'VITE_FIREBASE_CONFIG=' + JSON.stringify(webConfig) + '\n');
await writeFile('.firebaserc', JSON.stringify({projects: {default: config.projectId}}, null, 2) + '\n');
await mkdir('android/app/src/main/assets', {recursive: true});
await writeFile('android/app/src/main/assets/firebase.config.json', JSON.stringify(config, null, 2));
console.log('Configured web and Android for ' + config.projectId + '. No deployment or billing changes made.');
