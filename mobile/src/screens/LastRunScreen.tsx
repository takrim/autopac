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

const ACTIONABLE: MonitorAlertType[] = [
  "STRONG_BUY", "PULLBACK_BUY_ZONE", "BUY_SETUP", "MOMENTUM_BREAKOUT", "ACCUMULATION_SETUP",
];

// Per-category maximums (see backend scoring). Used to draw the F/N/T meter.
const MAX = { fundamental: 15, news: 10, technical: 15, total: 40 };

type Filter = "all" | "buys" | "watch";

const metaFor = (t?: MonitorAlertType) => ALERT_META[t ?? "NONE"] ?? ALERT_META.NONE;
const fmtPrice = (p: number) => (p >= 1 ? `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${p.toPrecision(3)}`);

// Color the score by how strong the overall setup is, for at-a-glance scanning.
function scoreColor(total: number): string {
  if (total >= 20) return "#5cb85c";
  if (total >= 12) return "#f0ad4e";
  return "#6c757d";
}

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Three slim bars showing Fundamental / News / Technical at a glance. */
function ScoreMeter({ f, n, t }: { f: number; n: number; t: number }) {
  const bar = (label: string, val: number, max: number) => {
    const pct = Math.max(0, Math.min(1, val / max));
    return (
      <View style={styles.meterRow} key={label}>
        <Text style={styles.meterLabel}>{label}</Text>
        <View style={styles.meterTrack}>
          <View style={[styles.meterFill, { width: `${pct * 100}%`, backgroundColor: val <= 0 ? "#d9534f" : "#5bc0de" }]} />
        </View>
        <Text style={styles.meterVal}>{val}</Text>
      </View>
    );
  };
  return (
    <View style={styles.meter}>
      {bar("F", f, MAX.fundamental)}
      {bar("N", n, MAX.news)}
      {bar("T", t, MAX.technical)}
    </View>
  );
}

export default function LastRunScreen() {
  const [run, setRun] = useState<MonitorRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MonitorCoin | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

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
  const strongBuys = coins.filter((c) => c.alertType === "STRONG_BUY").length;
  const actionable = coins.filter((c) => ACTIONABLE.includes(c.alertType)).length;
  const watching = coins.filter((c) => c.alertType === "FUNDAMENTAL_WATCH").length;

  const matchesFilter = (c: MonitorCoin) =>
    filter === "all" ? true
      : filter === "buys" ? ACTIONABLE.includes(c.alertType)
        : c.alertType === "FUNDAMENTAL_WATCH";

  const sections = SECTION_ORDER
    .map((type) => ({ type, meta: ALERT_META[type], data: coins.filter((c) => c.alertType === type && matchesFilter(c)) }))
    .filter((s) => s.data.length > 0);

  const runAt = run?.runAt?._seconds ? new Date(run.runAt._seconds * 1000) : null;
  // The monitor runs every 5 min; flag if the latest run looks stale (likely an outage).
  const stale = runAt ? (Date.now() - runAt.getTime()) / 60000 > 12 : false;

  const FilterChip = ({ value, label, count }: { value: Filter; label: string; count: number }) => (
    <TouchableOpacity
      style={[styles.chip, filter === value && styles.chipActive]}
      activeOpacity={0.7}
      onPress={() => setFilter(value)}
    >
      <Text style={[styles.chipText, filter === value && styles.chipTextActive]}>{label}</Text>
      <View style={[styles.chipCount, filter === value && styles.chipCountActive]}>
        <Text style={[styles.chipCountText, filter === value && styles.chipCountTextActive]}>{count}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.headerTitle}>
            {strongBuys > 0 ? `🚀 ${strongBuys} Strong Buy${strongBuys !== 1 ? "s" : ""}` : run ? `${actionable} buy signal${actionable !== 1 ? "s" : ""}` : "No runs yet"}
          </Text>
          <View style={styles.statusPill}>
            <View style={[styles.statusDot, { backgroundColor: stale ? "#f0ad4e" : "#5cb85c" }]} />
            <Text style={styles.statusText}>{runAt ? timeAgo(runAt) : "—"}</Text>
          </View>
        </View>
        <Text style={styles.headerSub}>
          {run ? `Scored ${coins.length} coins` : "Runs every 5 min"}{stale ? " · may be delayed" : ""} · tap a coin for analysis
        </Text>
        <View style={styles.chipRow}>
          <FilterChip value="all" label="All" count={coins.length} />
          <FilterChip value="buys" label="Buy signals" count={actionable} />
          <FilterChip value="watch" label="Watch" count={watching} />
        </View>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(c) => c.productId}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#e94560" />}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              {coins.length === 0 ? "No coins scored yet. The monitor runs every 5 minutes." : "Nothing in this view — try a different filter."}
            </Text>
          </View>
        }
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
              <View style={styles.rowTitleLine}>
                <Text style={styles.rowSymbol}>{item.symbol}</Text>
                {item.alertType === "STRONG_BUY" && (
                  <View style={styles.autoTag}><Text style={styles.autoTagText}>AUTO-BUY</Text></View>
                )}
                {item.majorBearish && item.alertType !== "RISK_BLOCK" && <Text style={styles.warnFlag}>⚠️</Text>}
              </View>
              <Text style={styles.rowSub}>
                {fmtPrice(item.price)}
                {item.strategies && item.strategies.length > 1 ? ` · ${item.strategies.length} signals align` : ""}
              </Text>
              <ScoreMeter f={item.fundamental} n={item.news} t={item.technical} />
            </View>
            <View style={styles.rowRight}>
              <View style={[styles.scoreBadge, { backgroundColor: scoreColor(item.total) }]}>
                <Text style={styles.scoreText}>{item.total}</Text>
              </View>
              <Text style={styles.scoreMax}>of {MAX.total}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
      />

      <Modal visible={selected !== null} animationType="slide" transparent={false} onRequestClose={() => setSelected(null)}>
        <SafeAreaView style={styles.modalContainer}>
          {selected && (
            <>
              <View style={styles.modalHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.modalTitle}>{metaFor(selected.alertType).emoji} {selected.symbol}</Text>
                  <Text style={[styles.modalAlert, { color: metaFor(selected.alertType).color }]}>{metaFor(selected.alertType).label} — {metaFor(selected.alertType).hint}</Text>
                </View>
                <TouchableOpacity onPress={() => setSelected(null)}><Text style={styles.modalClose}>✕</Text></TouchableOpacity>
              </View>
              <View style={styles.modalStats}>
                <View style={styles.modalStat}><Text style={styles.modalStatVal}>{fmtPrice(selected.price)}</Text><Text style={styles.modalStatLabel}>Price</Text></View>
                <View style={styles.modalStat}><Text style={[styles.modalStatVal, { color: scoreColor(selected.total) }]}>{selected.total}/{MAX.total}</Text><Text style={styles.modalStatLabel}>Score</Text></View>
                <View style={styles.modalStat}><Text style={styles.modalStatVal}>{selected.strategies?.length ?? 0}</Text><Text style={styles.modalStatLabel}>Signals</Text></View>
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
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: "#0f3460" },
  headerTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  headerSub: { color: "#888", fontSize: 12, marginTop: 2 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#16213e", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: "#bbb", fontSize: 12, fontWeight: "600" },
  chipRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: "#16213e", borderWidth: 1, borderColor: "#0f3460" },
  chipActive: { backgroundColor: "#0f3460", borderColor: "#e94560" },
  chipText: { color: "#999", fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: "#fff" },
  chipCount: { backgroundColor: "#0f3460", borderRadius: 9, minWidth: 18, paddingHorizontal: 5, paddingVertical: 1, alignItems: "center" },
  chipCountActive: { backgroundColor: "#e94560" },
  chipCountText: { color: "#aaa", fontSize: 11, fontWeight: "700" },
  chipCountTextActive: { color: "#fff" },
  sectionHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, gap: 8 },
  sectionDot: { width: 8, height: 8, borderRadius: 4 },
  sectionTitle: { fontSize: 14, fontWeight: "700", flex: 1 },
  sectionCount: { color: "#888", fontSize: 13, fontWeight: "600" },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#16213e", marginHorizontal: 12, marginVertical: 4,
    borderRadius: 10, padding: 14, borderLeftWidth: 4,
  },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowSymbol: { color: "#fff", fontSize: 17, fontWeight: "bold" },
  autoTag: { backgroundColor: "#5cb85c", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  autoTagText: { color: "#0b2912", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  warnFlag: { fontSize: 13 },
  rowSub: { color: "#888", fontSize: 12, marginTop: 3 },
  rowRight: { alignItems: "center" },
  scoreBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, minWidth: 40, alignItems: "center" },
  scoreText: { color: "#0b1220", fontSize: 16, fontWeight: "800" },
  scoreMax: { color: "#666", fontSize: 10, marginTop: 2 },
  chevron: { color: "#555", fontSize: 22 },
  // F/N/T meter
  meter: { marginTop: 8, gap: 3, maxWidth: 200 },
  meterRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  meterLabel: { color: "#777", fontSize: 10, fontWeight: "700", width: 10 },
  meterTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: "#0f3460", overflow: "hidden" },
  meterFill: { height: 4, borderRadius: 2 },
  meterVal: { color: "#999", fontSize: 10, width: 20, textAlign: "right" },
  modalContainer: { flex: 1, backgroundColor: "#1a1a2e" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#0f3460" },
  modalTitle: { color: "#fff", fontSize: 20, fontWeight: "700" },
  modalAlert: { fontSize: 12, fontWeight: "600", marginTop: 3, maxWidth: 280 },
  modalClose: { color: "#888", fontSize: 22, paddingLeft: 16 },
  modalStats: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 14 },
  modalStat: { flex: 1, alignItems: "center", backgroundColor: "#16213e", marginHorizontal: 4, borderRadius: 8, paddingVertical: 10 },
  modalStatVal: { color: "#fff", fontSize: 16, fontWeight: "700" },
  modalStatLabel: { color: "#888", fontSize: 11, marginTop: 2 },
  toggleRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  toggleBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: "#16213e", alignItems: "center", borderWidth: 1, borderColor: "#0f3460" },
  toggleBtnActive: { backgroundColor: "#0f3460", borderColor: "#e94560" },
  toggleText: { color: "#888", fontSize: 14, fontWeight: "600" },
  toggleTextActive: { color: "#e94560" },
  modalBody: { flex: 1 },
  analysisText: { color: "#ddd", fontSize: 14, lineHeight: 21 },
});
