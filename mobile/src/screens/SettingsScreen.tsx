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
  TextInput,
} from "react-native";
import * as Notifications from "expo-notifications";
import { signOut } from "../services/auth";
import { useAuth } from "../context/AuthContext";
import { fetchAccount, AlpacaAccount, fetchConfig, updateConfig, TradingConfig } from "../services/api";

const ALPACA_ONLY_BROKERS = new Set(["alpaca"]);

export default function SettingsScreen() {
  const { user } = useAuth();
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [account, setAccount] = useState<AlpacaAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [config, setConfig] = useState<TradingConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Notifications.getPermissionsAsync().then(({ status }) => {
      setNotificationsEnabled(status === "granted");
    });
    fetchAccount()
      .then(setAccount)
      .catch(() => setAccount(null))
      .finally(() => setAccountLoading(false));
    fetchConfig()
      .then(setConfig)
      .catch(() => setConfig(null))
      .finally(() => setConfigLoading(false));
  }, []);

  const saveConfig = async (updates: Partial<TradingConfig>) => {
    if (!config) return;
    setSaving(true);
    try {
      const updated = await updateConfig(updates);
      setConfig(updated);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to save config");
    } finally {
      setSaving(false);
    }
  };

  // Get active broker's settings for display
  const activeBroker = config?.ACTIVE_BROKER || "alpaca";
  const brokerTradeValue = config?.brokerSettings?.[activeBroker]?.tradeValueUsd ?? config?.TRADE_VALUE_USD ?? 1000;

  const handleBrokerTradeValueEdit = (current: number) => {
    Alert.prompt(
      "Set Trade Value (USD)",
      `Enter a value between 1 and 100000 for ${activeBroker.toUpperCase()}`,
      (value) => {
        const num = parseFloat(value);
        if (isNaN(num) || num < 1 || num > 100000) {
          Alert.alert("Invalid", "Must be between 1 and 100000");
          return;
        }
        const updatedBrokerSettings = {
          ...config?.brokerSettings,
          [activeBroker]: {
            ...config?.brokerSettings?.[activeBroker],
            tradeValueUsd: num,
          },
        };
        saveConfig({ brokerSettings: updatedBrokerSettings } as Partial<TradingConfig>);
      },
      "plain-text",
      String(current)
    );
  };

  const handleNumberEdit = (key: keyof TradingConfig, label: string, current: number, min: number, max: number, decimals = 0) => {
    Alert.prompt(
      `Set ${label}`,
      `Enter a value between ${min} and ${max}`,
      (value) => {
        const num = parseFloat(value);
        if (isNaN(num) || num < min || num > max) {
          Alert.alert("Invalid", `Must be between ${min} and ${max}`);
          return;
        }
        saveConfig({ [key]: parseFloat(num.toFixed(decimals > 0 ? decimals : 0)) });
      },
      "plain-text",
      String(current)
    );
  };

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
        {account && ALPACA_ONLY_BROKERS.has(config?.ACTIVE_BROKER || "alpaca") && (
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
        {ALPACA_ONLY_BROKERS.has(config?.ACTIVE_BROKER || "alpaca") && (
          <>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.label}>Paper Trading</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>ON</Text>
              </View>
            </View>
          </>
        )}
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

      {/* Trading Config */}
      <Text style={styles.sectionHeader}>TRADING CONFIG {saving && <ActivityIndicator size="small" color="#e94560" />}</Text>
      {configLoading ? (
        <View style={[styles.section, { paddingVertical: 20, alignItems: "center" }]}>
          <ActivityIndicator color="#e94560" />
        </View>
      ) : config ? (
        <>
          <View style={styles.section}>
            <View style={styles.row}>
              <View style={styles.labelGroup}>
                <Text style={styles.label}>Auto Approve</Text>
                <Text style={styles.hint}>Execute signals without manual review</Text>
              </View>
              <Switch
                value={config.AUTO_APPROVE}
                onValueChange={(v) => saveConfig({ AUTO_APPROVE: v })}
                trackColor={{ false: "#333", true: "#0f3460" }}
                thumbColor={config.AUTO_APPROVE ? "#e94560" : "#666"}
                disabled={saving}
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={styles.labelGroup}>
                <Text style={styles.label}>Order Pyramiding</Text>
                <Text style={styles.hint}>Allow multiple buys on same symbol</Text>
              </View>
              <Switch
                value={config.ORDER_PYRAMID}
                onValueChange={(v) => saveConfig({ ORDER_PYRAMID: v })}
                trackColor={{ false: "#333", true: "#0f3460" }}
                thumbColor={config.ORDER_PYRAMID ? "#e94560" : "#666"}
                disabled={saving}
              />
            </View>
          </View>

          <View style={styles.section}>
            <TouchableOpacity
              style={styles.row}
              onPress={() => handleBrokerTradeValueEdit(brokerTradeValue)}
              disabled={saving}
            >
              <Text style={styles.label}>Trade Value ({activeBroker.toUpperCase()})</Text>
              <Text style={styles.valueEdit}>${brokerTradeValue.toLocaleString()}</Text>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity
              style={styles.row}
              onPress={() => handleNumberEdit("STOP_LOSS_PCT", "Stop Loss %", config.STOP_LOSS_PCT, 0.1, 50, 2)}
              disabled={saving}
            >
              <Text style={styles.label}>Stop Loss</Text>
              <Text style={styles.valueEdit}>{config.STOP_LOSS_PCT}%</Text>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity
              style={styles.row}
              onPress={() => handleNumberEdit("TAKE_PROFIT_PCT", "Take Profit %", config.TAKE_PROFIT_PCT, 0.1, 100, 2)}
              disabled={saving}
            >
              <Text style={styles.label}>Take Profit</Text>
              <Text style={styles.valueEdit}>{config.TAKE_PROFIT_PCT}%</Text>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity
              style={styles.row}
              onPress={() => handleNumberEdit("MAX_DAILY_TRADES", "Max Daily Trades", config.MAX_DAILY_TRADES, 1, 500)}
              disabled={saving}
            >
              <Text style={styles.label}>Max Daily Trades</Text>
              <Text style={styles.valueEdit}>{config.MAX_DAILY_TRADES}</Text>
            </TouchableOpacity>
            {ALPACA_ONLY_BROKERS.has(config.ACTIVE_BROKER) && (
              <>
                <View style={styles.divider} />
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => handleNumberEdit("SIMULATED_FEE_RATE", "Fee Rate (e.g. 0.006 = 0.6%)", config.SIMULATED_FEE_RATE, 0, 0.1, 4)}
                  disabled={saving}
                >
                  <Text style={styles.label}>Simulated Fee Rate</Text>
                  <Text style={styles.valueEdit}>{(config.SIMULATED_FEE_RATE * 100).toFixed(4)}%</Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          <View style={styles.section}>
            <View style={styles.row}>
              <Text style={styles.label}>Trade Direction</Text>
              <View style={styles.segmentGroup}>
                {(["LONG", "SHORT", "BOTH"] as const).map((d) => (
                  <TouchableOpacity
                    key={d}
                    style={[styles.segment, config.ALLOWED_DIRECTIONS === d && styles.segmentActive]}
                    onPress={() => saveConfig({ ALLOWED_DIRECTIONS: d })}
                    disabled={saving}
                  >
                    <Text style={[styles.segmentText, config.ALLOWED_DIRECTIONS === d && styles.segmentTextActive]}>
                      {d}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.label}>Broker</Text>
              <View style={styles.segmentGroup}>
                {(["alpaca", "coinbase", "mock"] as const).map((b) => (
                  <TouchableOpacity
                    key={b}
                    style={[styles.segment, config.ACTIVE_BROKER === b && styles.segmentActive]}
                    onPress={() => saveConfig({ ACTIVE_BROKER: b })}
                    disabled={saving}
                  >
                    <Text style={[styles.segmentText, config.ACTIVE_BROKER === b && styles.segmentTextActive]}>
                      {b.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        </>
      ) : (
        <View style={[styles.section, { padding: 16 }]}>
          <Text style={{ color: "#d9534f" }}>Failed to load config</Text>
        </View>
      )}

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
  labelGroup: {
    flex: 1,
    marginRight: 12,
  },
  hint: {
    color: "#555",
    fontSize: 12,
    marginTop: 2,
  },
  valueEdit: {
    color: "#e94560",
    fontSize: 15,
    fontWeight: "600",
  },
  segmentGroup: {
    flexDirection: "row",
    gap: 6,
  },
  segment: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: "#0f3460",
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  segmentActive: {
    backgroundColor: "#e94560",
    borderColor: "#e94560",
  },
  segmentText: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
  },
  segmentTextActive: {
    color: "#fff",
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
