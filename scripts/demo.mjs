import { spawn } from 'node:child_process';
const child = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1'], {stdio:'inherit', env:{...process.env,
  VITE_USE_EMULATORS:'true', VITE_FIREBASE_CONFIG: JSON.stringify({apiKey:'demo-key', authDomain:'demo-timer-sync.firebaseapp.com',
    projectId:'demo-timer-sync', appId:'1:123456789:web:demotimer'})}});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
