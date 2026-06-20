import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Modal,
  ScrollView,
  SafeAreaView,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { fetchLastRun, MonitorRun, MonitorCoin, MonitorCategory } from "../services/api";

const CATEGORY_META: Record<MonitorCategory, { label: string; emoji: string; color: string }> = {
  STRONG_BUY: { label: "Strong Buy", emoji: "🚀", color: "#5cb85c" },
  WATCHLIST: { label: "Watchlist", emoji: "👀", color: "#f0ad4e" },
  AVOID: { label: "Avoid", emoji: "🛑", color: "#6c757d" },
};

export default function LastRunScreen() {
  const [run, setRun] = useState<MonitorRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MonitorCoin | null>(null);
  const [showFull, setShowFull] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setRun(await fetchLastRun());
    } catch (err: any) {
      setError(err.message || "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load])
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

  const runAt = run?.runAt?._seconds ? new Date(run.runAt._seconds * 1000) : null;

  return (
    <View style={styles.container}>
      <Text style={styles.header}>
        {run ? `Last run · ${run.count} coins` : "No runs yet"}
        {runAt ? `  ·  ${runAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}
      </Text>

      <FlatList
        data={run?.coins ?? []}
        keyExtractor={(c) => c.productId}
        numColumns={2}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={{ gap: 10 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#e94560" />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No coins scored yet. The monitor runs every 15 minutes.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const meta = CATEGORY_META[item.category];
          return (
            <TouchableOpacity
              style={[styles.tile, { borderColor: meta.color }]}
              activeOpacity={0.7}
              onPress={() => { setShowFull(false); setSelected(item); }}
            >
              <Text style={styles.tileSymbol}>{item.symbol}</Text>
              <Text style={[styles.tileCategory, { color: meta.color }]}>{meta.emoji} {meta.label}</Text>
              <Text style={styles.tileScore}>{item.total}/40</Text>
            </TouchableOpacity>
          );
        }}
      />

      <Modal visible={selected !== null} animationType="slide" transparent={false} onRequestClose={() => setSelected(null)}>
        <SafeAreaView style={styles.modalContainer}>
          {selected && (
            <>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {CATEGORY_META[selected.category].emoji} {selected.symbol}
                </Text>
                <TouchableOpacity onPress={() => setSelected(null)}>
                  <Text style={styles.modalClose}>✕</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.toggleRow}>
                <TouchableOpacity
                  style={[styles.toggleBtn, !showFull && styles.toggleBtnActive]}
                  onPress={() => setShowFull(false)}
                >
                  <Text style={[styles.toggleText, !showFull && styles.toggleTextActive]}>Simple</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toggleBtn, showFull && styles.toggleBtnActive]}
                  onPress={() => setShowFull(true)}
                >
                  <Text style={[styles.toggleText, showFull && styles.toggleTextActive]}>Full analysis</Text>
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.modalBody} contentContainerStyle={{ padding: 16 }}>
                <Text style={styles.analysisText}>{showFull ? selected.full : selected.friendly}</Text>
              </ScrollView>
            </>
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1a1a2e" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1a1a2e", padding: 24 },
  errorText: { color: "#d9534f", fontSize: 16 },
  emptyText: { color: "#888", fontSize: 14, textAlign: "center" },
  header: { color: "#aaa", fontSize: 13, fontWeight: "600", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  grid: { padding: 12, gap: 10, flexGrow: 1 },
  tile: {
    flex: 1,
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderLeftWidth: 4,
  },
  tileSymbol: { color: "#fff", fontSize: 18, fontWeight: "bold" },
  tileCategory: { fontSize: 12, fontWeight: "600", marginTop: 6 },
  tileScore: { color: "#888", fontSize: 13, marginTop: 4 },
  modalContainer: { flex: 1, backgroundColor: "#1a1a2e" },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#0f3460",
  },
  modalTitle: { color: "#fff", fontSize: 20, fontWeight: "700" },
  modalClose: { color: "#888", fontSize: 22, paddingLeft: 16 },
  toggleRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  toggleBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: "#16213e", alignItems: "center", borderWidth: 1, borderColor: "#0f3460" },
  toggleBtnActive: { backgroundColor: "#0f3460", borderColor: "#e94560" },
  toggleText: { color: "#888", fontSize: 14, fontWeight: "600" },
  toggleTextActive: { color: "#e94560" },
  modalBody: { flex: 1 },
  analysisText: { color: "#ddd", fontSize: 14, lineHeight: 21 },
});
