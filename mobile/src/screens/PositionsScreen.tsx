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
import { Position, fetchPositions, liquidatePosition } from "../services/api";

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
              {totalPl >= 0 ? "+" : ""}${totalPl.toFixed(2)}
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
  const pl = parseFloat(position.unrealized_pl || "0");
  const plPct = parseFloat(position.unrealized_plpc || "0") * 100;
  const intradayPl = parseFloat(position.unrealized_intraday_pl || "0");
  const qty = parseFloat(position.qty);
  const entry = parseFloat(position.avg_entry_price);
  const current = parseFloat(position.current_price);
  const marketValue = parseFloat(position.market_value || "0");
  const costBasis = parseFloat(position.cost_basis || "0");
  const simulatedFees = parseFloat(position.simulated_fees || "0");
  const feeRate = position.fee_rate ?? 0.006;

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
          {simulatedFees > 0 && (
            <DetailItem
              label={`Fees (${(feeRate * 100).toFixed(1)}%×2)`}
              value={`-$${simulatedFees.toFixed(2)}`}
              color="#e94560"
            />
          )}
        </View>
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
