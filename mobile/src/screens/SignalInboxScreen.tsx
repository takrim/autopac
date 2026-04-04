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
import { Signal, fetchSignals } from "../services/api";
import SignalCard from "../components/SignalCard";

interface Props {
  navigation: any;
}

const FILTER_OPTIONS = ["ALL", "PENDING", "EXECUTED", "FAILED"] as const;

export default function SignalInboxScreen({ navigation }: Props) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<string>("ALL");
  const [error, setError] = useState<string | null>(null);

  const loadSignals = useCallback(async () => {
    try {
      setError(null);
      const status = filter === "ALL" ? undefined : filter;
      const data = await fetchSignals(status);
      setSignals(data);
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
});
