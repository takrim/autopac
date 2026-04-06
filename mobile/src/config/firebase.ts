/**
 * Firebase configuration for the mobile app.
 * Values are loaded from app.json extra config via expo-constants.
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
import Constants from "expo-constants";

const extra = Constants.expoConfig?.extra ?? {};

const firebaseConfig = {
  apiKey: extra.firebaseApiKey,
  authDomain: extra.firebaseAuthDomain,
  projectId: extra.firebaseProjectId,
  storageBucket: extra.firebaseStorageBucket,
  messagingSenderId: extra.firebaseMessagingSenderId,
  appId: extra.firebaseAppId,
};

export const API_BASE_URL: string = extra.apiBaseUrl;

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
