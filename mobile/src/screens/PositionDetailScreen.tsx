import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Linking,
} from "react-native";
import { useRoute, useNavigation } from "@react-navigation/native";
import {
  Position,
  updateStopLoss,
  fetchLevels,
  fetchNews,
  LevelsResponse,
  NewsArticle,
} from "../services/api";

export default function PositionDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation();
  const position: Position = route.params?.position;

  const [levels, setLevels] = useState<LevelsResponse | null>(null);
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [levelsLoading, setLevelsLoading] = useState(true);
  const [newsLoading, setNewsLoading] = useState(true);
  const [updatingSL, setUpdatingSL] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const entry = parseFloat(position.avg_entry_price);
  const current = parseFloat(position.current_price);
  const qty = parseFloat(position.qty);
  const pl = parseFloat(position.unrealized_pl || "0");
  const plPct = parseFloat(position.unrealized_plpc || "0") * 100;
  const marketValue = parseFloat(position.market_value || "0");
  const costBasis = parseFloat(position.cost_basis || "0");
  const stopLoss = position.stop_loss ? parseFloat(position.stop_loss) : null;
  const actualFees = parseFloat(position.actual_fees || "0");
  const simulatedFees = parseFloat(position.simulated_fees || "0");
  const fees = actualFees > 0 ? actualFees : simulatedFees;

  // Breakeven price: entry + round-trip fees per unit
  // fees already include buy + estimated sell, so breakeven = costBasis + fees / qty
  const breakevenPrice = qty > 0 ? (costBasis + fees) / qty : entry;

  const loadData = useCallback(async () => {
    try {
      const [levelsData, newsData] = await Promise.all([
        fetchLevels(position.symbol).catch(() => null),
        fetchNews(position.symbol).catch(() => []),
      ]);
      setLevels(levelsData);
      setNews(newsData);
    } finally {
      setLevelsLoading(false);
      setNewsLoading(false);
      setRefreshing(false);
    }
  }, [position.symbol]);

  useEffect(() => {
    navigation.setOptions({ title: position.symbol });
    loadData();
  }, []);

  const handleSetSL = (price: number, label: string) => {
    Alert.alert(
      "Set Stop Loss",
      `Set stop loss for ${position.symbol} to $${price.toFixed(4)}?\n\n${label}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: async () => {
            setUpdatingSL(true);
            try {
              await updateStopLoss(position.symbol, price);
              Alert.alert("Done", `Stop loss set to $${price.toFixed(4)}`);
            } catch (err: any) {
              Alert.alert("Failed", err.message || "Failed to set stop loss");
            } finally {
              setUpdatingSL(false);
            }
          },
        },
      ]
    );
  };

  const pctAboveEntry = (pct: number) => {
    const price = entry * (1 + pct / 100);
    return { price, label: `${pct}% above entry ($${entry.toFixed(4)})` };
  };

  const pctBelowCurrent = (pct: number) => {
    const price = current * (1 - pct / 100);
    return { price, label: `${pct}% below current ($${current.toFixed(4)})` };
  };

  const formatTime = (ms: number) => {
    const d = new Date(ms);
    const now = Date.now();
    const diff = now - ms;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  };

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); loadData(); }}
          tintColor="#e94560"
        />
      }
    >
      {/* Position Summary */}
      <View style={styles.section}>
        <View style={styles.summaryRow}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Text style={styles.symbolText}>{position.symbol}</Text>
              {position.broker && (
                <View style={[styles.brokerBadge, position.broker === "alpaca" ? styles.brokerBadgeAlpaca : styles.brokerBadgeCoinbase]}>
                  <Text style={[styles.brokerBadgeText, position.broker === "alpaca" ? { color: "#f0ad4e" } : { color: "#5bc0de" }]}>
                    {position.broker === "alpaca" ? "Alpaca" : "Coinbase"}
                  </Text>
                </View>
              )}
            </View>
            <Text style={styles.subText}>{position.asset_class || "crypto"}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.plText, { color: pl >= 0 ? "#5cb85c" : "#d9534f" }]}>
              {pl >= 0 ? "+" : ""}${pl.toFixed(4)}
            </Text>
            <Text style={[styles.plPctText, { color: plPct >= 0 ? "#5cb85c" : "#d9534f" }]}>
              {plPct >= 0 ? "+" : ""}{plPct.toFixed(2)}%
            </Text>
          </View>
        </View>

        <View style={styles.grid}>
          <GridItem label="Entry" value={`$${entry.toFixed(4)}`} />
          <GridItem label="Current" value={`$${current.toFixed(4)}`} color={current >= entry ? "#5cb85c" : "#d9534f"} />
          <GridItem label="Quantity" value={qty > 1 ? qty.toFixed(4) : qty.toFixed(8)} />
          <GridItem label="Mkt Value" value={`$${marketValue.toFixed(2)}`} />
          <GridItem label="Cost Basis" value={`$${costBasis.toFixed(4)}`} />
          <GridItem label="Fees" value={`-$${fees.toFixed(4)}`} color="#e94560" />
          <GridItem label="Breakeven" value={`$${breakevenPrice.toFixed(4)}`} color="#f0ad4e" />
          <GridItem label="Stop Loss" value={stopLoss ? `$${stopLoss.toFixed(4)}` : "None"} color={stopLoss ? "#e94560" : "#666"} />
        </View>
      </View>

      {/* SL: Breakeven (0 P&L) */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>⚖️ Set Stop Loss to Breakeven</Text>
        <Text style={styles.sectionDesc}>
          Breakeven at ${breakevenPrice.toFixed(4)} (includes fees)
        </Text>
        <SLButton
          label={`SL → $${breakevenPrice.toFixed(4)} (0 P&L)`}
          onPress={() => handleSetSL(breakevenPrice, "Breakeven — covers entry + fees")}
          disabled={updatingSL}
          color="#f0ad4e"
        />
      </View>

      {/* SL: Percent above entry */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📈 % Above Entry Price</Text>
        <View style={styles.slRow}>
          {[1, 2, 3, 5].map(pct => {
            const { price, label } = pctAboveEntry(pct);
            return (
              <SLButton
                key={`above-${pct}`}
                label={`+${pct}% → $${price.toFixed(4)}`}
                onPress={() => handleSetSL(price, label)}
                disabled={updatingSL}
                color="#5cb85c"
                compact
              />
            );
          })}
        </View>
      </View>

      {/* SL: Percent below current */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📉 % Below Current Price</Text>
        <View style={styles.slRow}>
          {[1, 2, 3, 5].map(pct => {
            const { price, label } = pctBelowCurrent(pct);
            return (
              <SLButton
                key={`below-${pct}`}
                label={`-${pct}% → $${price.toFixed(4)}`}
                onPress={() => handleSetSL(price, label)}
                disabled={updatingSL}
                color="#e94560"
                compact
              />
            );
          })}
        </View>
      </View>

      {/* Support Levels */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🛡️ Support Levels</Text>
        {levelsLoading ? (
          <ActivityIndicator color="#e94560" style={{ marginVertical: 12 }} />
        ) : levels && levels.supports.length > 0 ? (
          <>
            <Text style={styles.sectionDesc}>Tap a level to set stop loss there</Text>
            {levels.supports.map((price, i) => {
              const pctFromEntry = ((price - entry) / entry * 100).toFixed(2);
              const pctFromCurrent = ((price - current) / current * 100).toFixed(2);
              return (
                <TouchableOpacity
                  key={i}
                  style={styles.levelRow}
                  onPress={() => handleSetSL(price, `Support level $${price.toFixed(4)}`)}
                  disabled={updatingSL}
                >
                  <View>
                    <Text style={styles.levelPrice}>${price.toFixed(4)}</Text>
                    <Text style={styles.levelMeta}>
                      {pctFromEntry}% from entry  ·  {pctFromCurrent}% from current
                    </Text>
                  </View>
                  <Text style={styles.levelAction}>Set SL →</Text>
                </TouchableOpacity>
              );
            })}
          </>
        ) : (
          <Text style={styles.emptyText}>No support levels found</Text>
        )}
      </View>

      {/* Resistance Levels */}
      {levels && levels.resistances.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🚀 Resistance Levels</Text>
          {levels.resistances.slice(0, 5).map((price, i) => {
            const pctFromCurrent = ((price - current) / current * 100).toFixed(2);
            return (
              <View key={i} style={styles.levelRow}>
                <View>
                  <Text style={styles.levelPrice}>${price.toFixed(4)}</Text>
                  <Text style={styles.levelMeta}>+{pctFromCurrent}% from current</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* News */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📰 News</Text>
        {newsLoading ? (
          <ActivityIndicator color="#e94560" style={{ marginVertical: 12 }} />
        ) : news.length > 0 ? (
          news.map((article) => (
            <TouchableOpacity
              key={article.id}
              style={styles.newsItem}
              onPress={() => Linking.openURL(article.url)}
            >
              <Text style={styles.newsTitle}>{article.title}</Text>
              <Text style={styles.newsMeta}>
                {article.source}  ·  {formatTime(article.publishedAt)}
              </Text>
              <Text style={styles.newsSummary} numberOfLines={2}>
                {article.summary}
              </Text>
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.emptyText}>No recent news</Text>
        )}
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function GridItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.gridItem}>
      <Text style={styles.gridLabel}>{label}</Text>
      <Text style={[styles.gridValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function SLButton({ label, onPress, disabled, color, compact }: {
  label: string; onPress: () => void; disabled?: boolean; color: string; compact?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.slButton, { borderColor: color }, compact && styles.slButtonCompact, disabled && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.slButtonText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1a1a2e" },
  section: {
    margin: 12,
    padding: 14,
    backgroundColor: "#16213e",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  sectionTitle: { color: "#fff", fontSize: 16, fontWeight: "600", marginBottom: 8 },
  sectionDesc: { color: "#888", fontSize: 13, marginBottom: 10 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  symbolText: { color: "#fff", fontSize: 22, fontWeight: "bold" },
  subText: { color: "#888", fontSize: 13, marginTop: 2 },
  plText: { fontSize: 20, fontWeight: "bold" },
  plPctText: { fontSize: 14, marginTop: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  gridItem: { width: "50%", paddingVertical: 6 },
  gridLabel: { color: "#888", fontSize: 12 },
  gridValue: { color: "#fff", fontSize: 15, fontWeight: "500", marginTop: 2 },
  slRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  slButton: {
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: "center",
    marginTop: 8,
  },
  slButtonCompact: { flex: 1, minWidth: "45%", paddingVertical: 8, paddingHorizontal: 8 },
  slButtonText: { fontSize: 13, fontWeight: "600" },
  levelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#0f346040",
  },
  levelPrice: { color: "#fff", fontSize: 15, fontWeight: "600" },
  levelMeta: { color: "#888", fontSize: 12, marginTop: 2 },
  levelAction: { color: "#e94560", fontSize: 13, fontWeight: "600" },
  newsItem: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#0f346040" },
  newsTitle: { color: "#fff", fontSize: 14, fontWeight: "600", lineHeight: 20 },
  newsMeta: { color: "#888", fontSize: 11, marginTop: 4 },
  newsSummary: { color: "#aaa", fontSize: 13, marginTop: 4, lineHeight: 18 },
  emptyText: { color: "#666", fontSize: 14, textAlign: "center", paddingVertical: 16 },
  brokerBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  brokerBadgeAlpaca: { backgroundColor: "#3a2a1a", borderColor: "#f0ad4e" },
  brokerBadgeCoinbase: { backgroundColor: "#1a2a3a", borderColor: "#5bc0de" },
  brokerBadgeText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
});
