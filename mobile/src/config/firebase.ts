/**
 * Firebase configuration for the mobile app.
 * Values are loaded from env.ts (gitignored) to prevent secrets in version control.
 */
import { initializeApp, getApps } from "firebase/app";
import { initializeAuth, getReactNativePersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { FIREBASE_CONFIG, API_BASE_URL } from "./env";

const firebaseConfig = FIREBASE_CONFIG;

export { API_BASE_URL };

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = getFirestore(app);

export default app;
