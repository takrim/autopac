import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  Switch,
  ActivityIndicator,
} from "react-native";
import * as Notifications from "expo-notifications";
import { signOut } from "../services/auth";
import { useAuth } from "../context/AuthContext";
import { fetchAccount, AlpacaAccount } from "../services/api";

export default function SettingsScreen() {
  const { user } = useAuth();
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [account, setAccount] = useState<AlpacaAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);

  useEffect(() => {
    // Check notification permission status
    Notifications.getPermissionsAsync().then(({ status }) => {
      setNotificationsEnabled(status === "granted");
    });
    // Load account to check broker connection
    fetchAccount()
      .then(setAccount)
      .catch(() => setAccount(null))
      .finally(() => setAccountLoading(false));
  }, []);

  const handleNotificationToggle = async () => {
    if (!notificationsEnabled) {
      const { status } = await Notifications.requestPermissionsAsync();
      setNotificationsEnabled(status === "granted");
      if (status !== "granted") {
        Alert.alert(
          "Permissions Required",
          "Enable notifications in your device settings to receive trading alerts."
        );
      }
    } else {
      Alert.alert(
        "Disable Notifications",
        "To disable notifications, go to your device Settings > AutoPac > Notifications."
      );
    }
  };

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: () => signOut(),
      },
    ]);
  };

  return (
    <ScrollView style={styles.container}>
      {/* Account Info */}
      <Text style={styles.sectionHeader}>ACCOUNT</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.label}>Email</Text>
          <Text style={styles.value}>{user?.email || "—"}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.label}>User ID</Text>
          <Text style={styles.valueMono}>{user?.uid?.slice(0, 16) || "—"}…</Text>
        </View>
      </View>

      {/* Broker Status */}
      <Text style={styles.sectionHeader}>BROKER</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.label}>Connection</Text>
          {accountLoading ? (
            <ActivityIndicator size="small" color="#e94560" />
          ) : (
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: account ? "#5cb85c" : "#d9534f" },
                ]}
              />
              <Text style={[styles.value, { color: account ? "#5cb85c" : "#d9534f" }]}>
                {account ? "Connected" : "Disconnected"}
              </Text>
            </View>
          )}
        </View>
        {account && (
          <>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.label}>Account Status</Text>
              <Text style={styles.value}>{account.status || "—"}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.label}>Day Trades</Text>
              <Text style={styles.value}>{account.daytrade_count ?? "—"}</Text>
            </View>
          </>
        )}
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.label}>Paper Trading</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>ON</Text>
          </View>
        </View>
      </View>

      {/* Notifications */}
      <Text style={styles.sectionHeader}>NOTIFICATIONS</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.label}>Push Notifications</Text>
          <Switch
            value={notificationsEnabled}
            onValueChange={handleNotificationToggle}
            trackColor={{ false: "#333", true: "#0f3460" }}
            thumbColor={notificationsEnabled ? "#e94560" : "#666"}
          />
        </View>
      </View>

      {/* Actions */}
      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>

      <Text style={styles.version}>AutoPac v1.0.0</Text>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    padding: 16,
  },
  sectionHeader: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 1,
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
  },
  section: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
  },
  divider: {
    height: 1,
    backgroundColor: "#0f3460",
  },
  label: {
    color: "#aaa",
    fontSize: 15,
  },
  value: {
    color: "#fff",
    fontSize: 15,
  },
  valueMono: {
    color: "#888",
    fontSize: 13,
    fontFamily: "monospace",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  badge: {
    backgroundColor: "#0f3460",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    color: "#5cb85c",
    fontSize: 12,
    fontWeight: "bold",
  },
  signOutButton: {
    backgroundColor: "#d9534f",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginTop: 32,
  },
  signOutText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  version: {
    color: "#444",
    textAlign: "center",
    marginTop: 24,
    fontSize: 13,
  },
});
