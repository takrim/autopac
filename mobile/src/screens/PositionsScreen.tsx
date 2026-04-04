import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Position, fetchPositions } from "../services/api";

export default function PositionsScreen() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadPositions = useCallback(async () => {
    try {
      const data = await fetchPositions();
      setPositions(data);
    } catch {
      // Show empty state
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadPositions();
    }, [loadPositions])
  );

  if (loading && !refreshing) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#e94560" />
      </View>
    );
  }

  const totalPl = positions.reduce(
    (sum, p) => sum + parseFloat(p.unrealized_pl || "0"),
    0
  );
  const totalValue = positions.reduce(
    (sum, p) => sum + parseFloat(p.market_value || "0"),
    0
  );

  return (
    <View style={styles.container}>
      {/* Summary bar */}
      {positions.length > 0 && (
        <View style={styles.summaryBar}>
          <View>
            <Text style={styles.summaryLabel}>Total Value</Text>
            <Text style={styles.summaryValue}>
              ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.summaryLabel}>Unrealized P&L</Text>
            <Text
              style={[
                styles.summaryValue,
                { color: totalPl >= 0 ? "#5cb85c" : "#d9534f" },
              ]}
            >
              {totalPl >= 0 ? "+" : ""}${totalPl.toFixed(2)}
            </Text>
          </View>
        </View>
      )}

      <FlatList
        data={positions}
        keyExtractor={(item) => item.symbol}
        renderItem={({ item }) => <PositionCard position={item} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              loadPositions();
            }}
            tintColor="#e94560"
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No open positions</Text>
          </View>
        }
        contentContainerStyle={positions.length === 0 ? styles.emptyContainer : undefined}
      />
    </View>
  );
}

function PositionCard({ position }: { position: Position }) {
  const pl = parseFloat(position.unrealized_pl || "0");
  const plPct = parseFloat(position.unrealized_plpc || "0") * 100;
  const intradayPl = parseFloat(position.unrealized_intraday_pl || "0");
  const qty = parseFloat(position.qty);
  const entry = parseFloat(position.avg_entry_price);
  const current = parseFloat(position.current_price);
  const marketValue = parseFloat(position.market_value || "0");
  const costBasis = parseFloat(position.cost_basis || "0");

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View>
          <Text style={styles.symbol}>{position.symbol}</Text>
          <Text style={styles.assetClass}>{position.asset_class || "crypto"}</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={[styles.pl, { color: pl >= 0 ? "#5cb85c" : "#d9534f" }]}>
            {pl >= 0 ? "+" : ""}${pl.toFixed(2)}
          </Text>
          <Text style={[styles.plPct, { color: plPct >= 0 ? "#5cb85c" : "#d9534f" }]}>
            {plPct >= 0 ? "+" : ""}{plPct.toFixed(2)}%
          </Text>
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.detailGrid}>
        <DetailItem label="Quantity" value={qty > 1 ? qty.toFixed(4) : qty.toFixed(8)} />
        <DetailItem label="Entry" value={`$${entry.toFixed(2)}`} />
        <DetailItem label="Current" value={`$${current.toFixed(2)}`} />
        <DetailItem label="Mkt Value" value={`$${marketValue.toFixed(2)}`} />
        <DetailItem label="Cost Basis" value={`$${costBasis.toFixed(2)}`} />
        <DetailItem
          label="Intraday"
          value={`${intradayPl >= 0 ? "+" : ""}$${intradayPl.toFixed(2)}`}
          color={intradayPl >= 0 ? "#5cb85c" : "#d9534f"}
        />
      </View>
    </View>
  );
}

function DetailItem({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={styles.detailItem}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1a1a2e",
  },
  emptyText: {
    color: "#666",
    fontSize: 16,
  },
  emptyContainer: {
    flex: 1,
  },
  summaryBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: "#16213e",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#0f3460",
  },
  summaryLabel: {
    color: "#888",
    fontSize: 12,
  },
  summaryValue: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
  card: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  symbol: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "bold",
  },
  assetClass: {
    color: "#666",
    fontSize: 12,
    marginTop: 2,
    textTransform: "uppercase",
  },
  pl: {
    fontSize: 17,
    fontWeight: "bold",
  },
  plPct: {
    fontSize: 13,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: "#0f3460",
    marginVertical: 12,
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  detailItem: {
    width: "33%",
    marginBottom: 8,
  },
  detailLabel: {
    color: "#666",
    fontSize: 11,
  },
  detailValue: {
    color: "#ddd",
    fontSize: 14,
    fontWeight: "500",
  },
});
