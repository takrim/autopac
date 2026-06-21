import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Modal,
  ScrollView,
  SafeAreaView,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { fetchLastRun, MonitorRun, MonitorCoin, MonitorAlertType } from "../services/api";

const ALERT_META: Record<MonitorAlertType, { label: string; emoji: string; color: string; hint: string }> = {
  STRONG_BUY: { label: "Strong Buy", emoji: "🚀", color: "#5cb85c", hint: "highest-confidence setup — auto-buys" },
  PULLBACK_BUY_ZONE: { label: "Pullback Buy Zone", emoji: "🎯", color: "#5cb85c", hint: "uptrend dipping to support" },
  BUY_SETUP: { label: "Buy Setup", emoji: "✅", color: "#5bc0de", hint: "reasonable candidate — confirm first" },
  MOMENTUM_BREAKOUT: { label: "Momentum Breakout", emoji: "🚦", color: "#5bc0de", hint: "moving with volume — riskier" },
  ACCUMULATION_SETUP: { label: "Accumulation", emoji: "🧺", color: "#f0ad4e", hint: "watch; small staged entries" },
  FUNDAMENTAL_WATCH: { label: "Fundamental Watch", emoji: "👀", color: "#f0ad4e", hint: "quality coin, no entry yet" },
  RISK_BLOCK: { label: "Risk Block", emoji: "🛑", color: "#d9534f", hint: "major bad news — avoid" },
  NONE: { label: "No Signal", emoji: "⚪", color: "#6c757d", hint: "nothing actionable" },
};

// Display order: actionable buys first, then watch, risk, none. Empty groups hidden.
const SECTION_ORDER: MonitorAlertType[] = [
  "STRONG_BUY", "PULLBACK_BUY_ZONE", "BUY_SETUP", "MOMENTUM_BREAKOUT",
  "ACCUMULATION_SETUP", "FUNDAMENTAL_WATCH", "RISK_BLOCK", "NONE",
];

const metaFor = (t?: MonitorAlertType) => ALERT_META[t ?? "NONE"] ?? ALERT_META.NONE;
const fmtPrice = (p: number) => (p >= 1 ? `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${p.toPrecision(3)}`);

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

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  if (loading && !refreshing) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#e94560" /></View>;
  }
  if (error) {
    return <View style={styles.center}><Text style={styles.errorText}>{error}</Text></View>;
  }

  const coins = run?.coins ?? [];
  const sections = SECTION_ORDER
    .map((type) => ({ type, meta: ALERT_META[type], data: coins.filter((c) => c.alertType === type) }))
    .filter((s) => s.data.length > 0);

  const runAt = run?.runAt?._seconds ? new Date(run.runAt._seconds * 1000) : null;
  const actionable = coins.filter((c) => ["STRONG_BUY", "PULLBACK_BUY_ZONE", "BUY_SETUP", "MOMENTUM_BREAKOUT", "ACCUMULATION_SETUP"].includes(c.alertType)).length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {run ? `${coins.length} coins · ${actionable} buy signal${actionable !== 1 ? "s" : ""}` : "No runs yet"}
        </Text>
        <Text style={styles.headerSub}>
          {runAt ? `Last run ${runAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "Runs every 15 min"} · tap a coin for analysis
        </Text>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(c) => c.productId}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#e94560" />}
        ListEmptyComponent={<View style={styles.center}><Text style={styles.emptyText}>No coins scored yet. The monitor runs every 15 minutes.</Text></View>}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <View style={[styles.sectionDot, { backgroundColor: section.meta.color }]} />
            <Text style={[styles.sectionTitle, { color: section.meta.color }]}>
              {section.meta.emoji} {section.meta.label}
            </Text>
            <Text style={styles.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        renderItem={({ item, section }) => (
          <TouchableOpacity style={[styles.row, { borderLeftColor: section.meta.color }]} activeOpacity={0.7} onPress={() => { setShowFull(false); setSelected(item); }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowSymbol}>{item.symbol}</Text>
              <Text style={styles.rowSub}>{fmtPrice(item.price)} · F{item.fundamental} N{item.news} T{item.technical}{item.strategies && item.strategies.length > 1 ? ` · ${item.strategies.length} signals` : ""}</Text>
            </View>
            <View style={styles.scoreBadge}><Text style={styles.scoreText}>{item.total}</Text></View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
      />

      <Modal visible={selected !== null} animationType="slide" transparent={false} onRequestClose={() => setSelected(null)}>
        <SafeAreaView style={styles.modalContainer}>
          {selected && (
            <>
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.modalTitle}>{metaFor(selected.alertType).emoji} {selected.symbol}</Text>
                  <Text style={[styles.modalAlert, { color: metaFor(selected.alertType).color }]}>{metaFor(selected.alertType).label} — {metaFor(selected.alertType).hint}</Text>
                </View>
                <TouchableOpacity onPress={() => setSelected(null)}><Text style={styles.modalClose}>✕</Text></TouchableOpacity>
              </View>
              <View style={styles.toggleRow}>
                <TouchableOpacity style={[styles.toggleBtn, !showFull && styles.toggleBtnActive]} onPress={() => setShowFull(false)}>
                  <Text style={[styles.toggleText, !showFull && styles.toggleTextActive]}>Simple</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.toggleBtn, showFull && styles.toggleBtnActive]} onPress={() => setShowFull(true)}>
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
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: "#0f3460" },
  headerTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  headerSub: { color: "#888", fontSize: 12, marginTop: 2 },
  sectionHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, gap: 8 },
  sectionDot: { width: 8, height: 8, borderRadius: 4 },
  sectionTitle: { fontSize: 14, fontWeight: "700", flex: 1 },
  sectionCount: { color: "#888", fontSize: 13, fontWeight: "600" },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#16213e", marginHorizontal: 12, marginVertical: 4,
    borderRadius: 10, padding: 14, borderLeftWidth: 4,
  },
  rowSymbol: { color: "#fff", fontSize: 17, fontWeight: "bold" },
  rowSub: { color: "#888", fontSize: 12, marginTop: 3 },
  scoreBadge: { backgroundColor: "#0f3460", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, minWidth: 40, alignItems: "center" },
  scoreText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  chevron: { color: "#555", fontSize: 22 },
  modalContainer: { flex: 1, backgroundColor: "#1a1a2e" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#0f3460" },
  modalTitle: { color: "#fff", fontSize: 20, fontWeight: "700" },
  modalAlert: { fontSize: 12, fontWeight: "600", marginTop: 3, maxWidth: 280 },
  modalClose: { color: "#888", fontSize: 22, paddingLeft: 16 },
  toggleRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  toggleBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: "#16213e", alignItems: "center", borderWidth: 1, borderColor: "#0f3460" },
  toggleBtnActive: { backgroundColor: "#0f3460", borderColor: "#e94560" },
  toggleText: { color: "#888", fontSize: 14, fontWeight: "600" },
  toggleTextActive: { color: "#e94560" },
  modalBody: { flex: 1 },
  analysisText: { color: "#ddd", fontSize: 14, lineHeight: 21 },
});
