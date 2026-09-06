import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensure } = require('../node_modules/firebase-tools/lib/ensureApiEnabled.js');
const identityPlatform = require('../node_modules/firebase-tools/lib/gcp/identityPlatform.js');
const auth = require('../node_modules/firebase-tools/lib/auth.js');
const { requireAuth } = require('../node_modules/firebase-tools/lib/requireAuth.js');

const projectId = process.argv[2];

if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
  throw new Error('Usage: npm run provision -- <firebase-project-id>');
}

const account = auth.getGlobalDefaultAccount();
if (!account) {
  throw new Error('Firebase CLI is not signed in. Run npm run login first.');
}

const options = { project: projectId };
auth.setActiveAccount(options, account);
await requireAuth(options);

await ensure(projectId, 'firestore.googleapis.com', 'firestore');
await ensure(projectId, 'identitytoolkit.googleapis.com', 'authentication');

const emailPasswordConfig = {
  signIn: {
    email: {
      enabled: true,
      passwordRequired: true,
    },
  },
};

try {
  await identityPlatform.updateConfig(projectId, emailPasswordConfig, 'signIn.email');
} catch (error) {
  if (error?.status !== 404) throw error;
  throw new Error(
    `Initialize Authentication once at https://console.firebase.google.com/project/${projectId}/authentication/providers, then rerun this command.`,
    { cause: error },
  );
}

const authConfig = await identityPlatform.getConfig(projectId);
if (!authConfig.signIn?.email?.enabled || !authConfig.signIn.email.passwordRequired) {
  throw new Error('Email/password authentication did not remain enabled after provisioning.');
}

console.log(`Firestore API and email/password authentication are enabled for ${projectId}.`);
