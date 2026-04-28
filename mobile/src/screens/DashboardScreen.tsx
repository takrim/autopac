import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import {
  AlpacaAccount,
  Position,
  PortfolioHistory,
  TradingConfig,
  PerformanceMetric,
  fetchAccount,
  fetchPositionsWithMeta,
  fetchPortfolioHistory,
  fetchConfig,
} from "../services/api";

export default function DashboardScreen() {
  const [account, setAccount] = useState<AlpacaAccount | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [cashBalance, setCashBalance] = useState(0);
  const [performance, setPerformance] = useState<Record<string, PerformanceMetric> | null>(null);
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [config, setConfig] = useState<TradingConfig | null>(null);
  const [chartPeriod, setChartPeriod] = useState("1W");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAlpaca = !config || config.ACTIVE_BROKER === "alpaca";

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [cfg, posData] = await Promise.all([fetchConfig(), fetchPositionsWithMeta()]);
      setConfig(cfg);
      setPositions(posData.positions);
      setCashBalance(posData.cashBalance ?? 0);
      setPerformance(posData.performance ?? null);

      const brokerIsAlpaca = cfg.ACTIVE_BROKER === "alpaca";
      if (brokerIsAlpaca) {
        const [acct, hist] = await Promise.all([
          fetchAccount(),
          fetchPortfolioHistory(chartPeriod, chartPeriod === "1D" ? "5Min" : "1D"),
        ]);
        setAccount(acct);
        setHistory(hist);
      } else {
        setAccount(null);
        setHistory(null);
      }
    } catch (err: any) {
      setError(err.message || "Failed to load data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [chartPeriod]);

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

  const equity = isAlpaca
    ? parseFloat(account?.equity || "0")
    : positions.reduce((sum, p) => sum + parseFloat(p.market_value || "0"), 0) + cashBalance;
  const lastEquity = parseFloat(account?.last_equity || "0");
  const dayPl = isAlpaca ? equity - lastEquity : 0;
  const dayPlPct = isAlpaca && lastEquity > 0 ? (dayPl / lastEquity) * 100 : 0;

  const totalUnrealizedPl = positions.reduce(
    (sum, p) => sum + parseFloat(p.unrealized_pl || "0"),
    0
  );
  const totalCostBasis = positions.reduce(
    (sum, p) => sum + parseFloat(p.cost_basis || "0"),
    0
  );
  const totalUnrealizedPlPct = totalCostBasis > 0 ? (totalUnrealizedPl / totalCostBasis) * 100 : 0;

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
        <Text style={styles.heroLabel}>{isAlpaca ? "Portfolio Value" : `Portfolio Value (${config?.ACTIVE_BROKER})`}</Text>
        <Text style={styles.heroValue}>${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
        {isAlpaca && (
          <View style={styles.heroRow}>
            <Text style={[styles.heroPl, { color: dayPl >= 0 ? "#5cb85c" : "#d9534f" }]}>
              {dayPl >= 0 ? "+" : ""}${dayPl.toFixed(4)} ({dayPlPct >= 0 ? "+" : ""}{dayPlPct.toFixed(4)}%)
            </Text>
            <Text style={styles.heroSub}>Today</Text>
          </View>
        )}
      </View>

      {/* Equity Chart — Alpaca only */}
      {isAlpaca && (
        <EquityChart
          history={history}
          period={chartPeriod}
          onPeriodChange={(p) => {
            setChartPeriod(p);
            setRefreshing(true);
            loadData();
          }}
        />
      )}

      {/* Account Stats */}
      <View style={styles.statsRow}>
        {isAlpaca ? (
          <>
            <StatCard label="Cash" value={`$${parseFloat(account?.cash || "0").toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
            <StatCard label="Buying Power" value={`$${parseFloat(account?.buying_power || "0").toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          </>
        ) : (
          <>
            <StatCard
              label="Cash (USD)"
              value={`$${cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            />
            <StatCard
              label="Open P&L"
              value={`${totalUnrealizedPl >= 0 ? "+" : ""}$${totalUnrealizedPl.toFixed(4)}`}
              subValue={`${totalUnrealizedPlPct >= 0 ? "+" : ""}${totalUnrealizedPlPct.toFixed(4)}%`}
              color={totalUnrealizedPl >= 0 ? "#5cb85c" : "#d9534f"}
            />
          </>
        )}
      </View>

      {/* Performance Metrics — Coinbase only */}
      {!isAlpaca && performance && (
        <View style={styles.perfCard}>
          <Text style={styles.perfTitle}>Realized P&L</Text>
          <View style={styles.perfRow}>
            {(["1d", "1w", "1m", "1y"] as const).map((period) => {
              const metric = performance[period];
              const pl = metric?.realizedPl ?? 0;
              const trades = metric?.trades ?? 0;
              return (
                <View key={period} style={styles.perfItem}>
                  <Text style={styles.perfPeriod}>{period.toUpperCase()}</Text>
                  <Text style={[styles.perfValue, { color: pl >= 0 ? "#5cb85c" : "#d9534f" }]}>
                    {pl >= 0 ? "+" : ""}${pl.toFixed(4)}
                  </Text>
                  <Text style={styles.perfTrades}>{trades} trade{trades !== 1 ? "s" : ""}</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {!isAlpaca && (
        <View style={styles.statsRow}>
          <StatCard label="Positions" value={String(positions.length)} />
        </View>
      )}

      {isAlpaca && (
        <View style={styles.statsRow}>
          <StatCard
            label="Open P&L"
            value={`${totalUnrealizedPl >= 0 ? "+" : ""}$${totalUnrealizedPl.toFixed(4)}`}
            subValue={`${totalUnrealizedPlPct >= 0 ? "+" : ""}${totalUnrealizedPlPct.toFixed(4)}%`}
            color={totalUnrealizedPl >= 0 ? "#5cb85c" : "#d9534f"}
          />
          <StatCard label="Positions" value={String(positions.length)} />
        </View>
      )}

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
  subValue,
  color,
}: {
  label: string;
  value: string;
  subValue?: string;
  color?: string;
}) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
      {subValue ? <Text style={[styles.statSubValue, color ? { color } : null]}>{subValue}</Text> : null}
    </View>
  );
}

const CHART_PERIODS = ["1D", "1W", "1M", "3M", "1A"] as const;
const CHART_WIDTH = Dimensions.get("window").width - 64;
const CHART_HEIGHT = 120;

function EquityChart({
  history,
  period,
  onPeriodChange,
}: {
  history: PortfolioHistory | null;
  period: string;
  onPeriodChange: (p: string) => void;
}) {
  if (!history || !history.equity || history.equity.length < 2) {
    return (
      <View style={styles.chartCard}>
        <View style={styles.chartPeriodRow}>
          {CHART_PERIODS.map((p) => (
            <TouchableOpacity
              key={p}
              style={[styles.periodBtn, period === p && styles.periodBtnActive]}
              onPress={() => onPeriodChange(p)}
            >
              <Text style={[styles.periodText, period === p && styles.periodTextActive]}>
                {p}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={[styles.chartArea, { justifyContent: "center", alignItems: "center" }]}>
          <Text style={{ color: "#666", fontSize: 13 }}>No chart data available</Text>
        </View>
      </View>
    );
  }

  const equityData = history.equity.filter((v) => v != null);
  const min = Math.min(...equityData);
  const max = Math.max(...equityData);
  const range = max - min || 1;
  const isPositive = equityData[equityData.length - 1] >= equityData[0];
  const lineColor = isPositive ? "#5cb85c" : "#d9534f";

  return (
    <View style={styles.chartCard}>
      <View style={styles.chartPeriodRow}>
        {CHART_PERIODS.map((p) => (
          <TouchableOpacity
            key={p}
            style={[styles.periodBtn, period === p && styles.periodBtnActive]}
            onPress={() => onPeriodChange(p)}
          >
            <Text style={[styles.periodText, period === p && styles.periodTextActive]}>
              {p}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.chartArea}>
        {/* Y-axis labels */}
        <View style={styles.yAxis}>
          <Text style={styles.yLabel}>${(max / 1000).toFixed(1)}k</Text>
          <Text style={styles.yLabel}>${(min / 1000).toFixed(1)}k</Text>
        </View>
        {/* Bar chart visualization */}
        <View style={styles.chartBars}>
          {equityData.map((val, i) => {
            const heightPct = ((val - min) / range) * 100;
            return (
              <View key={i} style={styles.barContainer}>
                <View
                  style={[
                    styles.bar,
                    {
                      height: `${Math.max(heightPct, 2)}%`,
                      backgroundColor: lineColor,
                      opacity: 0.3 + (i / equityData.length) * 0.7,
                    },
                  ]}
                />
              </View>
            );
          })}
        </View>
      </View>
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
  statSubValue: {
    color: "#aaa",
    fontSize: 13,
    marginTop: 2,
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
  chartCard: {
    backgroundColor: "#16213e",
    marginHorizontal: 16,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  chartPeriodRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginBottom: 12,
  },
  periodBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#1a1a2e",
  },
  periodBtnActive: {
    backgroundColor: "#0f3460",
  },
  periodText: {
    color: "#666",
    fontSize: 13,
    fontWeight: "600",
  },
  periodTextActive: {
    color: "#e94560",
  },
  chartArea: {
    height: CHART_HEIGHT,
    flexDirection: "row",
  },
  yAxis: {
    width: 44,
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  yLabel: {
    color: "#555",
    fontSize: 10,
  },
  chartBars: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 1,
  },
  barContainer: {
    flex: 1,
    height: "100%",
    justifyContent: "flex-end",
  },
  bar: {
    borderRadius: 1,
    minHeight: 2,
  },
  perfCard: {
    backgroundColor: "#16213e",
    marginHorizontal: 16,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  perfTitle: {
    color: "#888",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 12,
    textAlign: "center",
  },
  perfRow: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  perfItem: {
    alignItems: "center",
    flex: 1,
  },
  perfPeriod: {
    color: "#aaa",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
  },
  perfValue: {
    fontSize: 15,
    fontWeight: "bold",
  },
  perfTrades: {
    color: "#666",
    fontSize: 10,
    marginTop: 2,
  },
});
