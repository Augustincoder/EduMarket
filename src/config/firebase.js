// src/config/firebase.js
const admin = require('firebase-admin');
const logger = require('../utils/logger');

let firebaseApp = null;

function initFirebase() {
  if (firebaseApp) return firebaseApp;

  try {
    // We expect service account details in env or a JSON file
    // For safety in this environment, we'll try to parse from individual env vars
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Replace escaped newlines in the private key
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    };

    if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
      logger.warn('Firebase Admin credentials missing. Push notifications will be disabled.');
      return null;
    }

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    logger.info('Firebase Admin initialized successfully');
    return firebaseApp;
  } catch (error) {
    logger.error(`Firebase Admin initialization failed: ${error.message}`);
    return null;
  }
}

module.exports = { initFirebase, admin };
