import React, { useCallback, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Image,
  Modal,
  ScrollView,
  Linking,
  Alert,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { TrendingCrypto, fetchTrending, fetchConfig, updateConfig, TradingConfig } from "../services/api";

type SortMode = "price_change" | "gainers" | "losers" | "volume";

/** Convert Coinbase product_id "BTC-USD" → allowedSymbols format "BTCUSD", or stock "AAPL" → "AAPL" */
function toTickerSymbol(productId: string): string {
  return productId.replace("-", "");
}

export default function TrendingScreen() {
  const [items, setItems] = useState<TrendingCrypto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("price_change");
  const [selectedItem, setSelectedItem] = useState<TrendingCrypto | null>(null);
  const [allowedSymbols, setAllowedSymbols] = useState<string[]>([]);
  const [activeBroker, setActiveBroker] = useState<string>("coinbase");
  const [toggling, setToggling] = useState<string | null>(null);
  const [showAllowedOnly, setShowAllowedOnly] = useState(false);
  const configRef = useRef<TradingConfig | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [data, config] = await Promise.all([
        fetchTrending({ sort, limit: 50 }),
        fetchConfig(),
      ]);
      setItems(data);
      configRef.current = config;
      setActiveBroker(config.ACTIVE_BROKER);
      const bs = config.brokerSettings?.[config.ACTIVE_BROKER];
      setAllowedSymbols(bs?.allowedSymbols || []);
    } catch (err: any) {
      setError(err.message || "Failed to load trending data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sort]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadData();
    }, [loadData])
  );

  const toggleAllowlist = useCallback(async (productId: string) => {
    const ticker = toTickerSymbol(productId);
    const isCurrentlyAllowed = allowedSymbols.includes(ticker);
    const action = isCurrentlyAllowed ? "remove" : "add";

    const newSymbols = isCurrentlyAllowed
      ? allowedSymbols.filter((s) => s !== ticker)
      : [...allowedSymbols, ticker];

    setToggling(productId);
    try {
      const config = configRef.current;
      if (!config) throw new Error("Config not loaded");

      const updatedBrokerSettings = {
        ...config.brokerSettings,
        [activeBroker]: {
          ...config.brokerSettings[activeBroker],
          allowedSymbols: newSymbols,
        },
      };

      const updated = await updateConfig({ brokerSettings: updatedBrokerSettings });
      configRef.current = updated;
      const bs = updated.brokerSettings?.[updated.ACTIVE_BROKER];
      setAllowedSymbols(bs?.allowedSymbols || []);
    } catch (err: any) {
      Alert.alert("Error", `Failed to ${action} ${ticker}: ${err.message}`);
    } finally {
      setToggling(null);
    }
  }, [allowedSymbols, activeBroker]);

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const formatPrice = (price: number) => {
    if (price >= 1) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (price >= 0.01) return `$${price.toFixed(4)}`;
    return `$${price.toFixed(8)}`;
  };

  const formatVolume = (vol: number) => {
    if (vol >= 1e9) return `$${(vol / 1e9).toFixed(4)}B`;
    if (vol >= 1e6) return `$${(vol / 1e6).toFixed(4)}M`;
    if (vol >= 1e3) return `$${(vol / 1e3).toFixed(1)}K`;
    return `$${vol.toFixed(0)}`;
  };

  const formatPct = (pct: number) => {
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(4)}%`;
  };

  const renderSortButton = (mode: SortMode, label: string) => (
    <TouchableOpacity
      style={[styles.sortButton, sort === mode && styles.sortButtonActive]}
      onPress={() => setSort(mode)}
    >
      <Text style={[styles.sortButtonText, sort === mode && styles.sortButtonTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const renderItem = ({ item, index }: { item: TrendingCrypto; index: number }) => {
    const isPositive = item.priceChange24h >= 0;
    const changeColor = isPositive ? "#4caf50" : "#e94560";
    // For crypto: "BTC-USD" → "BTC"; for stocks: "AAPL" → "AAPL"
    const baseSymbol = item.symbol.includes("-") ? item.symbol.split("-")[0] : item.symbol;
    const ticker = toTickerSymbol(item.symbol);
    const isAllowed = allowedSymbols.includes(ticker);
    const isTogglingThis = toggling === item.symbol;

    return (
      <TouchableOpacity style={styles.row} onPress={() => setSelectedItem(item)}>
        <View style={styles.rankCol}>
          <Text style={styles.rank}>{index + 1}</Text>
        </View>

        <View style={styles.iconCol}>
          {item.imageUrl ? (
            <Image source={{ uri: item.imageUrl }} style={[styles.icon, { backgroundColor: item.color + "20" }]} />
          ) : (
            <View style={[styles.iconPlaceholder, { backgroundColor: item.color || "#888" }]}>
              <Text style={styles.iconText}>{baseSymbol.slice(0, 2)}</Text>
            </View>
          )}
        </View>

        <View style={styles.nameCol}>
          <Text style={styles.symbol} numberOfLines={1}>
            {baseSymbol}
            {isAllowed ? " ✅" : ""}
          </Text>
          <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
        </View>

        <View style={styles.priceCol}>
          <Text style={styles.price}>{formatPrice(item.price)}</Text>
          <Text style={styles.volume}>{formatVolume(item.quoteVolume24h)}</Text>
        </View>

        <TouchableOpacity
          style={[styles.allowlistBtn, isAllowed && styles.allowlistBtnActive]}
          onPress={() => toggleAllowlist(item.symbol)}
          disabled={isTogglingThis}
        >
          {isTogglingThis ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={[styles.allowlistBtnText, isAllowed && styles.allowlistBtnTextActive]}>
              {isAllowed ? "−" : "+"}
            </Text>
          )}
        </TouchableOpacity>

        <View style={[styles.changeCol, { backgroundColor: changeColor + "20" }]}>
          <Text style={[styles.change, { color: changeColor }]}>
            {formatPct(item.priceChange24h)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading && !refreshing) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#e94560" />
      </View>
    );
  }

  if (error && items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={loadData}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Mode badge */}
      <View style={styles.modeBadge}>
        <Text style={styles.modeBadgeText}>
          {activeBroker === "coinbase" ? "🪙 Crypto · Coinbase" : "📈 Stocks · Alpaca Paper"}
        </Text>
      </View>

      {/* Sort bar */}
      <View style={styles.sortBar}>
        {renderSortButton("price_change", "🔥 Trending")}
        {renderSortButton("gainers", "📈 Gainers")}
        {renderSortButton("losers", "📉 Losers")}
        {renderSortButton("volume", "💎 Volume")}
        <TouchableOpacity
          style={[styles.sortButton, showAllowedOnly && styles.filterButtonActive]}
          onPress={() => setShowAllowedOnly((v) => !v)}
        >
          <Text style={[styles.sortButtonText, showAllowedOnly && styles.sortButtonTextActive]}>
            {showAllowedOnly ? "✅ Allowed" : "☰ All"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Header row */}
      <View style={styles.headerRow}>
        <Text style={[styles.headerText, styles.rankCol]}>#</Text>
        <Text style={[styles.headerText, styles.iconCol]} />
        <Text style={[styles.headerText, styles.nameCol]}>Name</Text>
        <Text style={[styles.headerText, styles.priceCol]}>Price</Text>
        <Text style={[styles.headerText, styles.changeCol]}>24h</Text>
      </View>

      <FlatList
        data={showAllowedOnly ? items.filter((i) => allowedSymbols.includes(toTickerSymbol(i.symbol))) : items}
        renderItem={renderItem}
        keyExtractor={(item) => item.symbol}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#e94560" />}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      />

      {/* Detail modal */}
      <Modal visible={!!selectedItem} animationType="slide" transparent onRequestClose={() => setSelectedItem(null)}>
        {selectedItem && (
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <ScrollView showsVerticalScrollIndicator={false}>
                {/* Header */}
                <View style={styles.modalHeader}>
                  {selectedItem.imageUrl ? (
                    <Image source={{ uri: selectedItem.imageUrl }} style={styles.modalIcon} />
                  ) : (
                    <View style={[styles.modalIconPlaceholder, { backgroundColor: selectedItem.color || "#888" }]}>
                    <Text style={styles.modalIconText}>{(selectedItem.symbol.includes("-") ? selectedItem.symbol.split("-")[0] : selectedItem.symbol).slice(0, 2)}</Text>
                    </View>
                  )}
                  <View style={styles.modalHeaderText}>
                    <Text style={styles.modalName}>{selectedItem.name}</Text>
                    <Text style={styles.modalSymbol}>{selectedItem.symbol}</Text>
                  </View>
                </View>

                {/* Price + Change */}
                <View style={styles.modalPriceRow}>
                  <Text style={styles.modalPrice}>{formatPrice(selectedItem.price)}</Text>
                  <View style={[
                    styles.modalChangeBadge,
                    { backgroundColor: (selectedItem.priceChange24h >= 0 ? "#4caf50" : "#e94560") + "20" },
                  ]}>
                    <Text style={[
                      styles.modalChangeText,
                      { color: selectedItem.priceChange24h >= 0 ? "#4caf50" : "#e94560" },
                    ]}>
                      {formatPct(selectedItem.priceChange24h)}
                    </Text>
                  </View>
                </View>

                {/* Stats grid */}
                <View style={styles.statsGrid}>
                  <View style={styles.statItem}>
                    <Text style={styles.statLabel}>24h Volume</Text>
                    <Text style={styles.statValue}>{formatVolume(selectedItem.quoteVolume24h)}</Text>
                  </View>
                  <View style={styles.statItem}>
                    <Text style={styles.statLabel}>Vol Change</Text>
                    <Text style={[styles.statValue, {
                      color: selectedItem.volumeChange24h >= 0 ? "#4caf50" : "#e94560",
                    }]}>
                      {formatPct(selectedItem.volumeChange24h)}
                    </Text>
                  </View>
                  <View style={styles.statItem}>
                    <Text style={styles.statLabel}>Type</Text>
                    <Text style={styles.statValue}>{selectedItem.assetType}</Text>
                  </View>
                  {selectedItem.launchedAt ? (
                    <View style={styles.statItem}>
                      <Text style={styles.statLabel}>Launched</Text>
                      <Text style={styles.statValue}>{selectedItem.launchedAt}</Text>
                    </View>
                  ) : null}
                </View>

                {/* Description */}
                {selectedItem.description ? (
                  <View style={styles.descriptionSection}>
                    <Text style={styles.sectionTitle}>About</Text>
                    <Text style={styles.descriptionText}>{selectedItem.description}</Text>
                  </View>
                ) : null}

                {/* Website link */}
                {selectedItem.website ? (
                  <TouchableOpacity
                    style={styles.websiteButton}
                    onPress={() => Linking.openURL(selectedItem.website)}
                  >
                    <Text style={styles.websiteButtonText}>Visit Website →</Text>
                  </TouchableOpacity>
                ) : null}

                {/* Allowlist toggle */}
                {(() => {
                  const ticker = toTickerSymbol(selectedItem.symbol);
                  const isAllowed = allowedSymbols.includes(ticker);
                  const isTogglingThis = toggling === selectedItem.symbol;
                  return (
                    <TouchableOpacity
                      style={[styles.allowlistModalBtn, isAllowed && styles.allowlistModalBtnActive]}
                      onPress={() => toggleAllowlist(selectedItem.symbol)}
                      disabled={isTogglingThis}
                    >
                      {isTogglingThis ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.allowlistModalBtnText}>
                          {isAllowed ? `Remove ${ticker} from ${activeBroker} allowlist` : `Add ${ticker} to ${activeBroker} allowlist`}
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })()}
              </ScrollView>

              <TouchableOpacity style={styles.closeButton} onPress={() => setSelectedItem(null)}>
                <Text style={styles.closeButtonText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1a1a2e" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1a1a2e" },
  errorText: { color: "#e94560", fontSize: 16, marginBottom: 16, textAlign: "center", paddingHorizontal: 24 },
  retryButton: { backgroundColor: "#e94560", paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: "#fff", fontWeight: "bold" },
  modeBadge: { backgroundColor: "#16213e", paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#0f3460" },
  modeBadgeText: { color: "#888", fontSize: 12, fontWeight: "600", textAlign: "center" },

  // Sort bar
  sortBar: { flexDirection: "row", padding: 12, gap: 8 },
  sortButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: "#16213e" },
  sortButtonActive: { backgroundColor: "#e94560" },
  filterButtonActive: { backgroundColor: "#4caf50" },
  sortButtonText: { color: "#888", fontSize: 13, fontWeight: "600" },
  sortButtonTextActive: { color: "#fff" },

  // Header
  headerRow: { flexDirection: "row", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#0f3460" },
  headerText: { color: "#666", fontSize: 12, fontWeight: "600" },

  // List
  list: { paddingBottom: 20 },

  // Row
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#0f3460" },
  rankCol: { width: 28 },
  rank: { color: "#666", fontSize: 13, fontWeight: "600" },
  iconCol: { width: 40, alignItems: "center" },
  icon: { width: 32, height: 32, borderRadius: 16 },
  iconPlaceholder: { width: 32, height: 32, borderRadius: 16, justifyContent: "center", alignItems: "center" },
  iconText: { color: "#fff", fontSize: 12, fontWeight: "bold" },
  nameCol: { flex: 1, marginLeft: 8 },
  symbol: { color: "#fff", fontSize: 15, fontWeight: "700" },
  name: { color: "#888", fontSize: 12, marginTop: 1 },
  priceCol: { width: 100, alignItems: "flex-end", marginRight: 8 },
  price: { color: "#fff", fontSize: 14, fontWeight: "600" },
  volume: { color: "#666", fontSize: 11, marginTop: 2 },
  changeCol: { width: 72, alignItems: "center", paddingVertical: 6, borderRadius: 8 },
  change: { fontSize: 13, fontWeight: "700" },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalContent: { backgroundColor: "#1a1a2e", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: "85%" },
  modalHeader: { flexDirection: "row", alignItems: "center", marginBottom: 20 },
  modalIcon: { width: 48, height: 48, borderRadius: 24 },
  modalIconPlaceholder: { width: 48, height: 48, borderRadius: 24, justifyContent: "center", alignItems: "center" },
  modalIconText: { color: "#fff", fontSize: 18, fontWeight: "bold" },
  modalHeaderText: { marginLeft: 14, flex: 1 },
  modalName: { color: "#fff", fontSize: 22, fontWeight: "bold" },
  modalSymbol: { color: "#888", fontSize: 14, marginTop: 2 },

  modalPriceRow: { flexDirection: "row", alignItems: "center", marginBottom: 20, gap: 12 },
  modalPrice: { color: "#fff", fontSize: 28, fontWeight: "bold" },
  modalChangeBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  modalChangeText: { fontSize: 16, fontWeight: "700" },

  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 20 },
  statItem: { backgroundColor: "#16213e", borderRadius: 12, padding: 14, minWidth: "45%", flex: 1 },
  statLabel: { color: "#888", fontSize: 12, marginBottom: 4 },
  statValue: { color: "#fff", fontSize: 15, fontWeight: "600" },

  descriptionSection: { marginBottom: 20 },
  sectionTitle: { color: "#fff", fontSize: 18, fontWeight: "bold", marginBottom: 10 },
  descriptionText: { color: "#ccc", fontSize: 14, lineHeight: 22 },

  websiteButton: { backgroundColor: "#16213e", padding: 14, borderRadius: 12, alignItems: "center", marginBottom: 12 },
  websiteButtonText: { color: "#e94560", fontSize: 15, fontWeight: "600" },

  closeButton: { backgroundColor: "#0f3460", padding: 16, borderRadius: 12, alignItems: "center", marginTop: 8 },
  closeButtonText: { color: "#fff", fontSize: 16, fontWeight: "bold" },

  // Allowlist buttons
  allowlistBtn: { width: 32, height: 32, borderRadius: 16, borderWidth: 1.5, borderColor: "#0f3460", justifyContent: "center", alignItems: "center", marginRight: 6 },
  allowlistBtnActive: { backgroundColor: "#4caf50", borderColor: "#4caf50" },
  allowlistBtnText: { color: "#888", fontSize: 18, fontWeight: "bold", marginTop: -1 },
  allowlistBtnTextActive: { color: "#fff" },
  allowlistModalBtn: { backgroundColor: "#16213e", padding: 14, borderRadius: 12, alignItems: "center", marginBottom: 12, borderWidth: 1.5, borderColor: "#0f3460" },
  allowlistModalBtnActive: { borderColor: "#4caf50", backgroundColor: "#4caf5020" },
  allowlistModalBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
