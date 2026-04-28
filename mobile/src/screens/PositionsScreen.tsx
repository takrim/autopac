import React, { useCallback, useState, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Animated,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useFocusEffect } from "@react-navigation/native";
import { Position, fetchPositions, liquidatePosition, updateStopLoss } from "../services/api";

export default function PositionsScreen() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPositions = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchPositions();
      setPositions(data);
    } catch (err: any) {
      setError(err.message || "Failed to load positions");
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

  if (error && positions.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => {
            setLoading(true);
            loadPositions();
          }}
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
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
              {totalPl >= 0 ? "+" : ""}${totalPl.toFixed(4)}
            </Text>
          </View>
        </View>
      )}

      <FlatList
        data={positions}
        keyExtractor={(item) => item.symbol}
        renderItem={({ item }) => (
          <PositionCard position={item} onLiquidated={loadPositions} />
        )}
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

function PositionCard({ position, onLiquidated }: { position: Position; onLiquidated: () => void }) {
  const swipeableRef = useRef<Swipeable>(null);
  const [liquidating, setLiquidating] = useState(false);
  const [movingSloss, setMovingSloss] = useState(false);
  const pl = parseFloat(position.unrealized_pl || "0");
  const plPct = parseFloat(position.unrealized_plpc || "0") * 100;
  const intradayPl = parseFloat(position.unrealized_intraday_pl || "0");
  const qty = parseFloat(position.qty);
  const entry = parseFloat(position.avg_entry_price);
  const current = parseFloat(position.current_price);
  const stopLoss = position.stop_loss ? parseFloat(position.stop_loss) : null;
  const slPct = stopLoss !== null && entry > 0 ? ((stopLoss - entry) / entry) * 100 : null;

  // Move SL button logic:
  // - if profit% > 2%: trail to 1% below current price
  // - if profit > 0% but ≤ 2%: move to break-even (entry price)
  // - otherwise: hidden
  const showMoveSl = plPct > 0;
  const trailMode = plPct > 2;
  const newSlPrice = trailMode ? current * 0.99 : entry;
  const moveSLLabel = trailMode
    ? `Trail SL → $${newSlPrice.toFixed(4)} (-1% cur)`
    : `Move SL → Break Even $${entry.toFixed(4)}`;

  const handleMoveStopLoss = () => {
    Alert.alert(
      trailMode ? "Trail Stop Loss" : "Move to Break-Even",
      trailMode
        ? `Set stop loss to $${newSlPrice.toFixed(4)} (1% below current $${current.toFixed(4)})?`
        : `Move stop loss to entry price $${entry.toFixed(4)}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: async () => {
            setMovingSloss(true);
            try {
              await updateStopLoss(position.symbol, newSlPrice);
              Alert.alert("Stop Loss Updated", `${position.symbol} stop loss set to $${newSlPrice.toFixed(4)}`);
              onLiquidated(); // refresh positions
            } catch (err: any) {
              Alert.alert("Failed", err.message || "Failed to update stop loss");
            } finally {
              setMovingSloss(false);
            }
          },
        },
      ]
    );
  };
  const marketValue = parseFloat(position.market_value || "0");
  const costBasis = parseFloat(position.cost_basis || "0");
  const simulatedFees = parseFloat(position.simulated_fees || "0");
  const actualFees = parseFloat(position.actual_fees || "0");
  const feeRate = position.fee_rate ?? 0.006;
  const hasFees = actualFees > 0 || simulatedFees > 0;
  const fees = actualFees > 0 ? actualFees : simulatedFees;
  // Effective cost basis = entry cost + all fees (buy + estimated sell)
  const effectiveCostBasis = costBasis + fees;

  const handleLiquidate = () => {
    Alert.alert(
      "Liquidate Position",
      `Close ${position.symbol} (${qty > 1 ? qty.toFixed(4) : qty.toFixed(8)} shares) and cancel open orders?`,
      [
        {
          text: "Cancel",
          style: "cancel",
          onPress: () => swipeableRef.current?.close(),
        },
        {
          text: "Liquidate",
          style: "destructive",
          onPress: async () => {
            setLiquidating(true);
            const attemptLiquidate = async () => {
              try {
                const result = await liquidatePosition(position.symbol);
                Alert.alert(
                  "Position Closed",
                  `${position.symbol} liquidated.${result.cancelledOrders > 0 ? ` ${result.cancelledOrders} open order(s) cancelled.` : ""}`
                );
                onLiquidated();
                swipeableRef.current?.close();
              } catch (err: any) {
                Alert.alert(
                  "Liquidation Failed",
                  err.message || "Failed to liquidate position",
                  [
                    {
                      text: "Retry",
                      onPress: attemptLiquidate,
                    },
                    {
                      text: "Cancel",
                      style: "cancel",
                      onPress: () => swipeableRef.current?.close(),
                    },
                  ]
                );
              } finally {
                setLiquidating(false);
              }
            };
            attemptLiquidate();
          },
        },
      ]
    );
  };

  const renderRightActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>
  ) => {
    const scale = dragX.interpolate({
      inputRange: [-100, 0],
      outputRange: [1, 0.5],
      extrapolate: "clamp",
    });

    return (
      <TouchableOpacity
        style={styles.liquidateAction}
        onPress={handleLiquidate}
        disabled={liquidating}
      >
        {liquidating ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Animated.Text style={[styles.liquidateText, { transform: [{ scale }] }]}>
            Liquidate
          </Animated.Text>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
      overshootRight={false}
      onSwipeableOpen={handleLiquidate}
    >
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.symbol}>{position.symbol}</Text>
            <Text style={styles.assetClass}>{position.asset_class || "crypto"}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.pl, { color: pl >= 0 ? "#5cb85c" : "#d9534f" }]}>
              {pl >= 0 ? "+" : ""}${pl.toFixed(4)}
            </Text>
            <Text style={[styles.plPct, { color: plPct >= 0 ? "#5cb85c" : "#d9534f" }]}>
              {plPct >= 0 ? "+" : ""}{plPct.toFixed(4)}%
            </Text>
          </View>
        </View>

        <View style={styles.divider} />

        {/* Price row — current vs stop loss */}
        <View style={styles.priceRow}>
          <View style={styles.priceBlock}>
            <Text style={styles.priceLabel}>Current Price</Text>
            <Text style={[styles.priceValue, { color: stopLoss !== null && current <= stopLoss ? "#d9534f" : "#5cb85c" }]}>
              ${current.toFixed(4)}
            </Text>
          </View>
          <View style={[styles.priceBlock, { alignItems: "flex-end" }]}>
            <Text style={styles.priceLabel}>Stop Loss</Text>
            {stopLoss !== null ? (
              <>
                <Text style={styles.stopLossValue}>${stopLoss.toFixed(4)}</Text>
                <Text style={styles.stopLossPct}>{slPct !== null ? `${slPct >= 0 ? "+" : ""}${slPct.toFixed(2)}% from entry` : ""}</Text>
              </>
            ) : (
              <Text style={styles.noStopLoss}>No stop loss</Text>
            )}
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.detailGrid}>
          <DetailItem label="Quantity" value={qty > 1 ? qty.toFixed(4) : qty.toFixed(8)} />
          <DetailItem label="Entry" value={`$${entry.toFixed(4)}`} />
          <DetailItem label="Mkt Value" value={`$${marketValue.toFixed(4)}`} />
          <DetailItem label="Cost Basis" value={`$${costBasis.toFixed(4)}`} />
          <DetailItem
            label="Eff. Cost"
            value={`$${effectiveCostBasis.toFixed(4)}`}
            color="#f0ad4e"
          />
          {hasFees && (
            <DetailItem
              label={actualFees > 0 ? "Fees (actual)" : `Fees (${(feeRate * 100).toFixed(1)}%×2)`}
              value={`-$${fees.toFixed(4)}`}
              color="#e94560"
            />
          )}
        </View>

        {/* Move Stop Loss button */}
        {showMoveSl && (
          <TouchableOpacity
            style={[
              styles.moveSlButton,
              trailMode ? styles.moveSlButtonTrail : styles.moveSlButtonBreakEven,
              movingSloss && { opacity: 0.6 },
            ]}
            onPress={handleMoveStopLoss}
            disabled={movingSloss}
          >
            {movingSloss ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.moveSlButtonText}>
                {trailMode ? "🎯" : "⚖️"} {moveSLLabel}
              </Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    </Swipeable>
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
    borderRadius: 14,
    padding: 20,
    marginHorizontal: 16,
    marginVertical: 8,
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
    fontSize: 22,
    fontWeight: "bold",
  },
  assetClass: {
    color: "#666",
    fontSize: 12,
    marginTop: 2,
    textTransform: "uppercase",
  },
  pl: {
    fontSize: 20,
    fontWeight: "bold",
  },
  plPct: {
    fontSize: 14,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: "#0f3460",
    marginVertical: 14,
  },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    backgroundColor: "#0f1f3d",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 14,
  },
  priceBlock: {
    alignItems: "flex-start",
  },
  priceLabel: {
    color: "#888",
    fontSize: 12,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  priceValue: {
    fontSize: 20,
    fontWeight: "bold",
  },
  stopLossValue: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#e94560",
    textAlign: "right",
  },
  stopLossPct: {
    fontSize: 12,
    color: "#e94560",
    opacity: 0.8,
    marginTop: 2,
    textAlign: "right",
  },
  noStopLoss: {
    fontSize: 15,
    color: "#555",
    fontStyle: "italic",
  },
  moveSlButton: {
    marginTop: 14,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  moveSlButtonBreakEven: {
    backgroundColor: "#1a4a2e",
    borderWidth: 1,
    borderColor: "#5cb85c",
  },
  moveSlButtonTrail: {
    backgroundColor: "#1a3a4a",
    borderWidth: 1,
    borderColor: "#5bc0de",
  },
  moveSlButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  detailItem: {
    width: "33%",
    marginBottom: 12,
  },
  detailLabel: {
    color: "#666",
    fontSize: 12,
  },
  detailValue: {
    color: "#ddd",
    fontSize: 15,
    fontWeight: "500",
    marginTop: 2,
  },
  errorText: {
    color: "#d9534f",
    fontSize: 16,
    marginBottom: 12,
  },
  retryButton: {
    backgroundColor: "#0f3460",
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryText: {
    color: "#e94560",
    fontSize: 14,
    fontWeight: "600",
  },
  liquidateAction: {
    backgroundColor: "#d9534f",
    justifyContent: "center",
    alignItems: "center",
    width: 100,
    marginVertical: 6,
    marginRight: 16,
    borderRadius: 12,
  },
  liquidateText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "bold",
  },
});
