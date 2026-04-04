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

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.symbolRow}>
          <Text style={[styles.side, { color: sideColor }]}>{order.side}</Text>
          <Text style={styles.symbol}>{order.symbol}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
          <Text style={styles.statusText}>{order.status}</Text>
        </View>
      </View>

      <View style={styles.details}>
        <Text style={styles.detail}>Qty: {order.quantity}</Text>
        <Text style={styles.detail}>Type: {order.orderType}</Text>
        <Text style={styles.detail}>Broker: {order.broker}</Text>
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
});
