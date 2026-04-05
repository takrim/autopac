import React, { useEffect, useRef } from "react";
import { NavigationContainer, NavigationContainerRef } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { AuthProvider } from "./src/context/AuthContext";
import AppNavigator from "./src/navigation/AppNavigator";

export const navigationRef = React.createRef<NavigationContainerRef<any>>();

export default function App() {
  const notificationListener = useRef<Notifications.EventSubscription>();
  const responseListener = useRef<Notifications.EventSubscription>();

  useEffect(() => {
    // Push token registration is handled in AuthContext after login.
    // Here we only set up notification listeners.

    // Listen for incoming notifications (foreground)
    notificationListener.current = Notifications.addNotificationReceivedListener(
      (notification) => {
        console.log("[APP] Notification received:", notification.request.content);
      }
    );

    // Listen for notification taps — navigate to signal detail
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data;
        console.log("[APP] Notification tapped:", data);
        if (data?.signalId && navigationRef.current) {
          navigationRef.current.navigate("Main", {
            screen: "SignalsTab",
            params: {
              screen: "SignalDetail",
              params: { signalId: data.signalId },
            },
          });
        }
      }
    );

    return () => {
      if (notificationListener.current) {
        Notifications.removeNotificationSubscription(notificationListener.current);
      }
      if (responseListener.current) {
        Notifications.removeNotificationSubscription(responseListener.current);
      }
    };
  }, []);

  return (
    <AuthProvider>
      <NavigationContainer ref={navigationRef}>
        <StatusBar style="light" />
        <AppNavigator />
      </NavigationContainer>
    </AuthProvider>
  );
}
