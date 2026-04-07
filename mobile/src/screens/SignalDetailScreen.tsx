import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import {
  Signal,
  fetchSignal,
  approveSignal,
  rejectSignal,
} from "../services/api";

interface Props {
  route: { params: { signalId: string } };
  navigation: any;
}

export default function SignalDetailScreen({ route, navigation }: Props) {
  const { signalId } = route.params;
  const [signal, setSignal] = useState<Signal | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    loadSignal();
  }, [signalId]);

  const loadSignal = async () => {
    try {
      const data = await fetchSignal(signalId);
      setSignal(data);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to load signal");
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = () => {
    Alert.alert(
      "Confirm Trade",
      `Execute ${signal?.action} ${signal?.symbol} @ $${signal?.price.toFixed(2)}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve",
          style: "default",
          onPress: async () => {
            setActing(true);
            try {
              const result = await approveSignal(signalId);
              Alert.alert("Success", `Trade ${result.order?.status || "approved"}`);
              loadSignal();
            } catch (err: any) {
              Alert.alert("Error", err.message || "Failed to approve");
            } finally {
              setActing(false);
            }
          },
        },
      ]
    );
  };

  const handleReject = () => {
    Alert.alert("Reject Signal", "Are you sure you want to reject this signal?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reject",
        style: "destructive",
        onPress: async () => {
          setActing(true);
          try {
            await rejectSignal(signalId);
            Alert.alert("Rejected", "Signal has been rejected");
            loadSignal();
          } catch (err: any) {
            Alert.alert("Error", err.message || "Failed to reject");
          } finally {
            setActing(false);
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#e94560" />
      </View>
    );
  }

  if (!signal) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Signal not found</Text>
      </View>
    );
  }

  const actionColor = signal.action === "BUY" ? "#5cb85c" : "#d9534f";
  const isPending = signal.status === "PENDING";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.action, { color: actionColor }]}>
          {signal.action}
        </Text>
        <Text style={styles.symbol}>{signal.symbol}</Text>
        <Text style={styles.price}>@ ${signal.price.toFixed(2)}</Text>
      </View>

      {/* Status */}
      <View style={[styles.statusBar, { backgroundColor: getStatusColor(signal.status) }]}>
        <Text style={styles.statusText}>{signal.status}</Text>
      </View>

      {/* Status Message (for failed signals) */}
      {signal.statusMessage ? (
        <View style={styles.statusMessageBar}>
          <Text style={styles.statusMessageText}>{signal.statusMessage}</Text>
        </View>
      ) : null}

      {/* Details */}
      <View style={styles.section}>
        <DetailRow label="Strategy" value={signal.strategy} />
        <DetailRow label="Timeframe" value={signal.timeframe} />
        <DetailRow
          label="Stop Loss"
          value={signal.stopLoss ? `$${signal.stopLoss.toFixed(2)}` : "—"}
        />
        <DetailRow
          label="Take Profit"
          value={signal.takeProfit ? `$${signal.takeProfit.toFixed(2)}` : "—"}
        />
        <DetailRow
          label="Trend Confirm"
          value={
            signal.strongBuy
              ? "⚡ STRONG BUY"
              : signal.bullishTrend != null
                ? (signal.bullishTrend ? "Bullish ▲" : "Bearish ▼")
                : "Awaiting…"
          }
          valueColor={signal.strongBuy ? "#ff9800" : signal.bullishTrend === true ? "#5cb85c" : signal.bullishTrend === false ? "#d9534f" : "#666"}
        />
        <DetailRow
          label="RSI (14)"
          value={signal.rsi != null ? `${signal.rsi.toFixed(1)} — ${signal.rsiTrend || ""}` : "Calculating…"}
          valueColor={
            signal.rsi != null
              ? signal.rsi < 30 ? "#5cb85c" : signal.rsi > 70 ? "#d9534f" : "#fff"
              : "#666"
          }
        />
        <DetailRow
          label="VWAP"
          value={
            signal.vwapPrice
              ? `$${signal.vwapPrice.toFixed(2)} — ${signal.vwapTrend === "bullish" ? "Price Above" : signal.vwapTrend === "bearish" ? "Price Below" : "At VWAP"}`
              : "Calculating…"
          }
          valueColor={
            signal.vwapTrend === "bullish"
              ? "#5cb85c"
              : signal.vwapTrend === "bearish"
                ? "#d9534f"
                : "#666"
          }
        />
        {signal.bulltrendVolume != null && (
          <DetailRow label="Volume" value={signal.bulltrendVolume.toLocaleString()} />
        )}
        <DetailRow
          label="Signal Time"
          value={new Date(signal.signalTime).toLocaleString()}
        />
      </View>

      {/* Action Buttons */}
      {isPending && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.approveButton, acting && styles.buttonDisabled]}
            onPress={handleApprove}
            disabled={acting}
          >
            {acting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>✅ Approve Trade</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.rejectButton, acting && styles.buttonDisabled]}
            onPress={handleReject}
            disabled={acting}
          >
            <Text style={styles.buttonText}>❌ Reject Trade</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    PENDING: "#f0ad4e",
    APPROVED: "#5bc0de",
    REJECTED: "#d9534f",
    EXECUTED: "#5cb85c",
    FAILED: "#d9534f",
  };
  return colors[status] || "#888";
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
  },
  content: {
    padding: 20,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1a1a2e",
  },
  header: {
    alignItems: "center",
    marginBottom: 20,
  },
  action: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 4,
  },
  symbol: {
    fontSize: 36,
    fontWeight: "bold",
    color: "#fff",
  },
  price: {
    fontSize: 22,
    color: "#ddd",
    marginTop: 4,
  },
  statusBar: {
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 20,
  },
  statusText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
  },
  statusMessageBar: {
    backgroundColor: "rgba(217, 83, 79, 0.15)",
    borderWidth: 1,
    borderColor: "#d9534f",
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
  },
  statusMessageText: {
    color: "#ff6b6b",
    fontSize: 14,
  },
  section: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#0f3460",
  },
  detailLabel: {
    color: "#888",
    fontSize: 15,
  },
  detailValue: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "500",
  },
  actions: {
    gap: 12,
  },
  approveButton: {
    backgroundColor: "#5cb85c",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  rejectButton: {
    backgroundColor: "#d9534f",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
  },
  errorText: {
    color: "#d9534f",
    fontSize: 16,
  },
});
