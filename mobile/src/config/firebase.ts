/**
 * Firebase configuration for the mobile app.
 * Values are loaded from env.ts (gitignored) to prevent secrets in version control.
 */
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeAuth,
  getAuth,
  getReactNativePersistence,
  Auth,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import ReactNativeAsyncStorage from "@react-native-async-storage/async-storage";
import { FIREBASE_CONFIG, API_BASE_URL } from "./env";

const firebaseConfig = FIREBASE_CONFIG;

export { API_BASE_URL };

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// On cold start, initializeAuth sets up AsyncStorage persistence.
// On hot reload, initializeAuth throws "already initialized" so we fall back to getAuth.
let auth: Auth;
try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(ReactNativeAsyncStorage),
  });
} catch {
  auth = getAuth(app);
}

export { auth };

export const db = getFirestore(app);

export default app;
