// Firebase Admin SDK initialization for the Tangle bot.
// Loads credentials from FIREBASE_SERVICE_ACCOUNT_JSON env var, configures the
// Realtime DB URL from FIREBASE_DB_URL, and exposes Firestore + helpers.

import admin from 'firebase-admin';

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const dbUrl = process.env.FIREBASE_DB_URL;

if (!serviceAccountJson) {
  throw new Error(
    'Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable. ' +
      'Paste the service-account JSON (single line) into the env vars.'
  );
}

if (!dbUrl) {
  throw new Error(
    'Missing FIREBASE_DB_URL environment variable. Expected the Realtime DB URL ' +
      '(e.g. https://fir-e9a0b-default-rtdb.firebaseio.com).'
  );
}

let parsedServiceAccount;
try {
  parsedServiceAccount = JSON.parse(serviceAccountJson);
} catch (err) {
  throw new Error(
    'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(parsedServiceAccount),
    databaseURL: dbUrl,
  });
}

export const db = admin.firestore();
export const Timestamp = admin.firestore.Timestamp;
export const FieldValue = admin.firestore.FieldValue;

// The existing auth-state code uses raw HTTP fetch against Realtime DB so we
// just expose the URL for it.
export const REALTIME_DB_URL = dbUrl;

export default admin;
