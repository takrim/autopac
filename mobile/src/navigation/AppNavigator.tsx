import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Text } from "react-native";

import { useAuth } from "../context/AuthContext";
import LoginScreen from "../screens/LoginScreen";
import SignalInboxScreen from "../screens/SignalInboxScreen";
import SignalDetailScreen from "../screens/SignalDetailScreen";
import OrdersScreen from "../screens/OrdersScreen";
import SettingsScreen from "../screens/SettingsScreen";

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: "#16213e" },
  headerTintColor: "#fff",
  headerTitleStyle: { fontWeight: "bold" as const },
};

function SignalsStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="SignalInbox"
        component={SignalInboxScreen}
        options={{ title: "Signals" }}
      />
      <Stack.Screen
        name="SignalDetail"
        component={SignalDetailScreen}
        options={{ title: "Signal Detail" }}
      />
    </Stack.Navigator>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarStyle: { backgroundColor: "#16213e", borderTopColor: "#0f3460" },
        tabBarActiveTintColor: "#e94560",
        tabBarInactiveTintColor: "#888",
        headerShown: false,
      }}
    >
      <Tab.Screen
        name="SignalsTab"
        component={SignalsStack}
        options={{
          title: "Signals",
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>📊</Text>,
        }}
      />
      <Tab.Screen
        name="OrdersTab"
        component={OrdersScreen}
        options={{
          title: "Orders",
          ...screenOptions,
          headerShown: true,
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>📋</Text>,
        }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsScreen}
        options={{
          title: "Settings",
          ...screenOptions,
          headerShown: true,
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>⚙️</Text>,
        }}
      />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const { user, loading } = useAuth();

  if (loading) {
    return null; // Splash screen would show here
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {user ? (
        <Stack.Screen name="Main" component={MainTabs} />
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} />
      )}
    </Stack.Navigator>
  );
}
