import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import {
  AlpacaAccount,
  Position,
  fetchAccount,
  fetchPositions,
} from "../services/api";

export default function DashboardScreen() {
  const [account, setAccount] = useState<AlpacaAccount | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [acct, pos] = await Promise.all([fetchAccount(), fetchPositions()]);
      setAccount(acct);
      setPositions(pos);
    } catch (err: any) {
      setError(err.message || "Failed to load data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadData();
    }, [loadData])
  );

  if (loading && !refreshing) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#e94560" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  const equity = parseFloat(account?.equity || "0");
  const lastEquity = parseFloat(account?.last_equity || "0");
  const dayPl = equity - lastEquity;
  const dayPlPct = lastEquity > 0 ? (dayPl / lastEquity) * 100 : 0;

  const totalUnrealizedPl = positions.reduce(
    (sum, p) => sum + parseFloat(p.unrealized_pl || "0"),
    0
  );

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            loadData();
          }}
          tintColor="#e94560"
        />
      }
    >
      {/* Portfolio Value */}
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>Portfolio Value</Text>
        <Text style={styles.heroValue}>${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
        <View style={styles.heroRow}>
          <Text style={[styles.heroPl, { color: dayPl >= 0 ? "#5cb85c" : "#d9534f" }]}>
            {dayPl >= 0 ? "+" : ""}${dayPl.toFixed(2)} ({dayPlPct >= 0 ? "+" : ""}{dayPlPct.toFixed(2)}%)
          </Text>
          <Text style={styles.heroSub}>Today</Text>
        </View>
      </View>

      {/* Account Stats */}
      <View style={styles.statsRow}>
        <StatCard label="Cash" value={`$${parseFloat(account?.cash || "0").toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
        <StatCard label="Buying Power" value={`$${parseFloat(account?.buying_power || "0").toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
      </View>

      <View style={styles.statsRow}>
        <StatCard
          label="Open P&L"
          value={`${totalUnrealizedPl >= 0 ? "+" : ""}$${totalUnrealizedPl.toFixed(2)}`}
          color={totalUnrealizedPl >= 0 ? "#5cb85c" : "#d9534f"}
        />
        <StatCard label="Positions" value={String(positions.length)} />
      </View>

      {/* Active Positions Preview */}
      <Text style={styles.sectionTitle}>Active Positions</Text>
      {positions.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>No open positions</Text>
        </View>
      ) : (
        positions.map((pos) => {
          const pl = parseFloat(pos.unrealized_pl || "0");
          const plPct = parseFloat(pos.unrealized_plpc || "0") * 100;
          return (
            <View key={pos.symbol} style={styles.posCard}>
              <View style={styles.posHeader}>
                <Text style={styles.posSymbol}>{pos.symbol}</Text>
                <Text style={[styles.posPl, { color: pl >= 0 ? "#5cb85c" : "#d9534f" }]}>
                  {pl >= 0 ? "+" : ""}${pl.toFixed(2)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(2)}%)
                </Text>
              </View>
              <View style={styles.posDetails}>
                <Text style={styles.posDetail}>Qty: {parseFloat(pos.qty).toFixed(6)}</Text>
                <Text style={styles.posDetail}>Entry: ${parseFloat(pos.avg_entry_price).toFixed(2)}</Text>
                <Text style={styles.posDetail}>Now: ${parseFloat(pos.current_price).toFixed(2)}</Text>
              </View>
            </View>
          );
        })
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
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
  errorText: {
    color: "#d9534f",
    fontSize: 16,
  },
  heroCard: {
    backgroundColor: "#16213e",
    margin: 16,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  heroLabel: {
    color: "#888",
    fontSize: 14,
    marginBottom: 4,
  },
  heroValue: {
    color: "#fff",
    fontSize: 36,
    fontWeight: "bold",
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  heroPl: {
    fontSize: 16,
    fontWeight: "600",
  },
  heroSub: {
    color: "#666",
    fontSize: 14,
  },
  statsRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  statLabel: {
    color: "#888",
    fontSize: 12,
    marginBottom: 4,
  },
  statValue: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
  sectionTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
  },
  emptyCard: {
    backgroundColor: "#16213e",
    marginHorizontal: 16,
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  emptyText: {
    color: "#666",
    fontSize: 14,
  },
  posCard: {
    backgroundColor: "#16213e",
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  posHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  posSymbol: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
  posPl: {
    fontSize: 15,
    fontWeight: "600",
  },
  posDetails: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  posDetail: {
    color: "#888",
    fontSize: 13,
  },
});
