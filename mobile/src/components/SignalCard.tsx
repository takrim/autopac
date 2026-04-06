import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Signal } from "../services/api";

interface Props {
  signal: Signal;
  onPress: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "#f0ad4e",
  APPROVED: "#5bc0de",
  REJECTED: "#d9534f",
  EXECUTED: "#5cb85c",
  FAILED: "#d9534f",
};

export default function SignalCard({ signal, onPress }: Props) {
  const statusColor = STATUS_COLORS[signal.status] || "#888";
  const actionColor = signal.action === "BUY" ? "#5cb85c" : "#d9534f";

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.header}>
        <View style={styles.symbolRow}>
          <Text style={[styles.action, { color: actionColor }]}>
            {signal.action}
          </Text>
          <Text style={styles.symbol}>{signal.symbol}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
          <Text style={styles.statusText}>{signal.status}</Text>
        </View>
      </View>

      <View style={styles.details}>
        <Text style={styles.price}>@ ${signal.price.toFixed(2)}</Text>
        <View style={styles.indicatorRow}>
          <Text style={styles.strategy}>{signal.strategy}</Text>
          {signal.rsi != null && (
            <View style={[styles.rsiBadge, {
              backgroundColor: signal.rsi < 30 ? "#5cb85c" : signal.rsi > 70 ? "#d9534f" : "#0f3460",
            }]}>
              <Text style={styles.rsiText}>RSI {signal.rsi.toFixed(0)}</Text>
            </View>
          )}
          {signal.vwapTrend && (
            <View style={[styles.rsiBadge, {
              backgroundColor: signal.vwapTrend === "bullish" ? "#5cb85c" : signal.vwapTrend === "bearish" ? "#d9534f" : "#0f3460",
            }]}>
              <Text style={styles.rsiText}>
                {signal.vwapTrend === "bullish" ? "▲ Above" : signal.vwapTrend === "bearish" ? "▼ Below" : "= At"} VWAP
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={styles.timeframe}>{signal.timeframe}</Text>
        <Text style={styles.time}>
          {new Date(signal.signalTime).toLocaleString()}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  symbolRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  action: {
    fontSize: 14,
    fontWeight: "bold",
  },
  symbol: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#fff",
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "bold",
  },
  details: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  price: {
    color: "#ddd",
    fontSize: 16,
  },
  indicatorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  strategy: {
    color: "#888",
    fontSize: 14,
  },
  rsiBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  rsiText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  timeframe: {
    color: "#666",
    fontSize: 12,
  },
  time: {
    color: "#666",
    fontSize: 12,
  },
});
