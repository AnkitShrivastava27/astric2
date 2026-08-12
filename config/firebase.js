/**
 * config/firebase.js
 * One Firebase Admin SDK instance, shared by every route/service.
 */
'use strict';

const admin = require('firebase-admin');
const env = require('./env');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: env.FIREBASE_PROJECT_ID,
    clientEmail: env.FIREBASE_CLIENT_EMAIL,
    privateKey: env.FIREBASE_PRIVATE_KEY,
  }),
});

const db = admin.firestore();

module.exports = { admin, db };
