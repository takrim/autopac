import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Order } from "../services/api";

interface Props {
  order: Order;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "#f0ad4e",
  FILLED: "#5cb85c",
  PARTIALLY_FILLED: "#5bc0de",
  CANCELLED: "#888",
  FAILED: "#d9534f",
};

export default function OrderCard({ order }: Props) {
  const statusColor = STATUS_COLORS[order.status] || "#888";
  const sideColor = order.side === "BUY" ? "#5cb85c" : "#d9534f";
  const broker = order.broker;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.symbolRow}>
          <Text style={[styles.side, { color: sideColor }]}>{order.side}</Text>
          <Text style={styles.symbol}>{order.symbol}</Text>
          {broker && (
            <View style={[styles.brokerBadge, broker === "alpaca" ? styles.brokerBadgeAlpaca : styles.brokerBadgeCoinbase]}>
              <Text style={[styles.brokerBadgeText, broker === "alpaca" ? { color: "#f0ad4e" } : { color: "#5bc0de" }]}>
                {broker === "alpaca" ? "Alpaca" : "Coinbase"}
              </Text>
            </View>
          )}
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
          <Text style={styles.statusText}>{order.status}</Text>
        </View>
      </View>

      <View style={styles.details}>
        <Text style={styles.detail}>Qty: {order.quantity}</Text>
        <Text style={styles.detail}>Type: {order.orderType}</Text>
      </View>
    </View>
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
  side: {
    fontSize: 14,
    fontWeight: "bold",
  },
  symbol: {
    fontSize: 18,
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
  },
  detail: {
    color: "#888",
    fontSize: 13,
  },
  brokerBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
  },
  brokerBadgeAlpaca: {
    backgroundColor: "#3a2a1a",
    borderColor: "#f0ad4e",
  },
  brokerBadgeCoinbase: {
    backgroundColor: "#1a2a3a",
    borderColor: "#5bc0de",
  },
  brokerBadgeText: {
    fontSize: 9,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
