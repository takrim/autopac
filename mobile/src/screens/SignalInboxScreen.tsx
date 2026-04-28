import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Signal, fetchSignals, Decision, fetchDecisions } from "../services/api";
import SignalCard from "../components/SignalCard";

interface Props {
  navigation: any;
}

const FILTER_OPTIONS = ["ALL", "PENDING", "EXECUTED", "FAILED"] as const;
type TabMode = "signals" | "debug";

export default function SignalInboxScreen({ navigation }: Props) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<string>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabMode>("signals");

  const loadSignals = useCallback(async () => {
    try {
      setError(null);
      const status = filter === "ALL" ? undefined : filter;
      const [signalData, decisionData] = await Promise.all([
        fetchSignals(status),
        fetchDecisions({ limit: 100 }),
      ]);
      setSignals(signalData);
      setDecisions(decisionData);
    } catch (err: any) {
      setError(err.message || "Failed to load signals");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadSignals();
    }, [loadSignals])
  );

  const onRefresh = () => {
    setRefreshing(true);
    loadSignals();
  };

  if (loading && !refreshing) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#e94560" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Tab Bar: Signals | Debug */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, tab === "signals" && styles.tabActive]}
          onPress={() => setTab("signals")}
        >
          <Text style={[styles.tabText, tab === "signals" && styles.tabTextActive]}>
            Signals
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === "debug" && styles.tabActive]}
          onPress={() => setTab("debug")}
        >
          <Text style={[styles.tabText, tab === "debug" && styles.tabTextActive]}>
            Debug {decisions.length > 0 ? `(${decisions.length})` : ""}
          </Text>
        </TouchableOpacity>
      </View>

      {tab === "signals" ? (
        <>
          {/* Filter Bar */}
          <View style={styles.filterBar}>
            {FILTER_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt}
                style={[
                  styles.filterButton,
                  filter === opt && styles.filterButtonActive,
                ]}
                onPress={() => setFilter(opt)}
              >
                <Text
                  style={[
                    styles.filterText,
                    filter === opt && styles.filterTextActive,
                  ]}
                >
                  {opt}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {error ? (
            <View style={styles.center}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={loadSignals}>
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <FlatList
              data={signals}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <SignalCard
                  signal={item}
                  onPress={() =>
                    navigation.navigate("SignalDetail", { signalId: item.id })
                  }
                />
              )}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor="#e94560"
                />
              }
              ListEmptyComponent={
                <View style={styles.center}>
                  <Text style={styles.emptyText}>No signals yet</Text>
                </View>
              }
              contentContainerStyle={signals.length === 0 ? styles.emptyContainer : undefined}
            />
          )}
        </>
      ) : (
        /* Debug Tab */
        <FlatList
          data={decisions}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#e94560"
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>No signal activity yet</Text>
            </View>
          }
          renderItem={({ item: d }) => (
            <View style={styles.decisionCard}>
              <View style={styles.decisionTopRow}>
                <Text style={styles.decisionSymbol}>{d.symbol}</Text>
                <View
                  style={[
                    styles.decisionBadge,
                    {
                      backgroundColor:
                        d.decision === "bought" || d.decision === "sold"
                          ? "#5cb85c"
                          : d.decision === "rejected"
                          ? "#d9534f55"
                          : "#f0ad4e55",
                    },
                  ]}
                >
                  <Text style={styles.decisionBadgeText}>
                    {d.decision.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.decisionHandler}>{d.handler}</Text>
              </View>
              <View style={styles.decisionMeta}>
                {d.rsi != null && (
                  <Text style={styles.decisionRsi}>RSI {d.rsi}</Text>
                )}
                {d.price != null && (
                  <Text style={styles.decisionPrice}>
                    ${d.price < 1 ? d.price.toPrecision(4) : d.price.toFixed(4)}
                  </Text>
                )}
                <Text style={styles.decisionTime}>
                  {d.createdAt?._seconds
                    ? new Date(d.createdAt._seconds * 1000).toLocaleTimeString()
                    : ""}
                </Text>
              </View>
              {d.reasons.map((r, i) => (
                <Text key={i} style={styles.decisionReason}>
                  • {r}
                </Text>
              ))}
            </View>
          )}
          contentContainerStyle={decisions.length === 0 ? styles.emptyContainer : undefined}
        />
      )}
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
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#0f3460",
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: "#e94560",
  },
  tabText: {
    color: "#555",
    fontSize: 14,
    fontWeight: "600",
  },
  tabTextActive: {
    color: "#fff",
  },
  filterBar: {
    flexDirection: "row",
    padding: 12,
    gap: 8,
  },
  filterButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "#16213e",
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  filterButtonActive: {
    backgroundColor: "#e94560",
    borderColor: "#e94560",
  },
  filterText: {
    color: "#888",
    fontSize: 13,
    fontWeight: "600",
  },
  filterTextActive: {
    color: "#fff",
  },
  emptyText: {
    color: "#666",
    fontSize: 16,
  },
  emptyContainer: {
    flex: 1,
  },
  errorText: {
    color: "#d9534f",
    fontSize: 16,
    marginBottom: 12,
  },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "#e94560",
    borderRadius: 8,
  },
  retryText: {
    color: "#fff",
    fontWeight: "600",
  },
  decisionCard: {
    backgroundColor: "#121a30",
    marginHorizontal: 16,
    marginVertical: 3,
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  decisionTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  decisionSymbol: {
    color: "#aaa",
    fontSize: 13,
    fontWeight: "700",
  },
  decisionBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  decisionBadgeText: {
    color: "#ccc",
    fontSize: 10,
    fontWeight: "600",
  },
  decisionHandler: {
    color: "#555",
    fontSize: 10,
    marginLeft: "auto",
  },
  decisionMeta: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 4,
  },
  decisionRsi: {
    color: "#7E57C2",
    fontSize: 11,
    fontWeight: "600",
  },
  decisionPrice: {
    color: "#666",
    fontSize: 11,
  },
  decisionTime: {
    color: "#444",
    fontSize: 11,
    marginLeft: "auto",
  },
  decisionReason: {
    color: "#777",
    fontSize: 11,
    lineHeight: 16,
  },
});
