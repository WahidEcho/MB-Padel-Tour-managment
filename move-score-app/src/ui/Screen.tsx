import { type ReactNode, useState } from "react";
import { RefreshControl, ScrollView, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { StageLight } from "./StageLight";

/** A scrolling page on the stage: beams behind, safe areas respected, room for the tab bar. */
export function Screen({ children, onRefresh, stage = true, tabs = true, style }: { children: ReactNode; onRefresh?: () => Promise<unknown>; stage?: boolean; tabs?: boolean; style?: ViewStyle }) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <View style={{ flex: 1, backgroundColor: t.floor }}>
      {stage && <StageLight />}
      <ScrollView
        contentContainerStyle={[{ paddingTop: insets.top + 8, paddingHorizontal: 18, paddingBottom: (tabs ? 110 : 30) + insets.bottom }, style]}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              tintColor={t.ball}
              colors={[t.ball]}
              progressBackgroundColor={t.surface}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                try {
                  await onRefresh();
                } finally {
                  setRefreshing(false);
                }
              }}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}
