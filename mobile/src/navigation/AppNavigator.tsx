import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Text } from "react-native";

import { useAuth } from "../context/AuthContext";
import LoginScreen from "../screens/LoginScreen";
import DashboardScreen from "../screens/DashboardScreen";
import LastRunScreen from "../screens/LastRunScreen";
import PositionsScreen from "../screens/PositionsScreen";
import OrdersScreen from "../screens/OrdersScreen";
import SettingsScreen from "../screens/SettingsScreen";
import TrendingScreen from "../screens/TrendingScreen";
import PositionDetailScreen from "../screens/PositionDetailScreen";

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: "#16213e" },
  headerTintColor: "#fff",
  headerTitleStyle: { fontWeight: "bold" as const },
};

function PositionsStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="PositionsList"
        component={PositionsScreen}
        options={{ title: "Positions" }}
      />
      <Stack.Screen
        name="PositionDetail"
        component={PositionDetailScreen}
        options={{ title: "Position Detail" }}
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
        name="DashboardTab"
        component={DashboardScreen}
        options={{
          title: "Dashboard",
          ...screenOptions,
          headerShown: true,
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>📈</Text>,
        }}
      />
      {/* Trending tab temporarily hidden — keep the screen + import for later.
      <Tab.Screen
        name="TrendingTab"
        component={TrendingScreen}
        options={{
          title: "Trending",
          ...screenOptions,
          headerShown: true,
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>🔥</Text>,
        }}
      />
      */}
      <Tab.Screen
        name="LastRunTab"
        component={LastRunScreen}
        options={{
          title: "Monitor",
          ...screenOptions,
          headerShown: true,
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>📊</Text>,
        }}
      />
      <Tab.Screen
        name="PositionsTab"
        component={PositionsStack}
        options={{
          title: "Positions",
          headerShown: false,
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>💰</Text>,
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
    return null;
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {user ? (
        <>
          <Stack.Screen name="Main" component={MainTabs} />
          <Stack.Screen
            name="PositionDetailModal"
            component={PositionDetailScreen}
            options={{ headerShown: true, ...screenOptions, title: "Position Detail" }}
          />
        </>
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} />
      )}
    </Stack.Navigator>
  );
}
