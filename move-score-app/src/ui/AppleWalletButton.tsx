import { ActivityIndicator, Pressable, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import Svg, { Path, Rect } from "react-native-svg";

/** The Wallet glyph: a stack of coloured cards tucked into a pocket. */
function WalletGlyph({ size }: { size: number }) {
  return (
    <Svg width={size} height={size * 0.8} viewBox="0 0 30 24">
      <Rect x={1} y={0.5} width={28} height={13} rx={3} fill="#3D8FE0" />
      <Rect x={1} y={3.6} width={28} height={13} rx={3} fill="#2FB36C" />
      <Rect x={1} y={6.7} width={28} height={13} rx={3} fill="#F7AA1E" />
      <Rect x={1} y={9.8} width={28} height={13} rx={3} fill="#EE4D3D" />
      <Path d="M1 13.4h8.2c1.1 0 1.9.6 2.4 1.5.7 1.3 1.9 2.1 3.4 2.1s2.7-.8 3.4-2.1c.5-.9 1.3-1.5 2.4-1.5H29v7.1c0 1.9-1.6 3.5-3.5 3.5h-21C2.6 24 1 22.4 1 20.5z" fill="#DCD8CF" />
    </Svg>
  );
}

/**
 * Apple's "Add to Apple Wallet" badge, drawn to its proportions: a black rounded
 * rectangle with a hairline grey rim, the Wallet glyph, and two lines of white
 * system type. Shown only on Apple devices (see pass/wallet.ts).
 */
export function AppleWalletButton({ onPress, busy, height = 48 }: { onPress: () => void; busy?: boolean; height?: number }) {
  const k = height / 48;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add to Apple Wallet"
      accessibilityState={{ busy: Boolean(busy) }}
      disabled={busy}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => ({
        height,
        minWidth: 168 * k,
        paddingHorizontal: 14 * k,
        borderRadius: 9 * k,
        backgroundColor: "#000000",
        borderWidth: 1,
        borderColor: "#A6A6A6",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 9 * k,
        alignSelf: "center",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <>
          <WalletGlyph size={30 * k} />
          <View>
            <Text allowFontScaling={false} style={{ color: "#FFFFFF", fontSize: 11 * k, lineHeight: 13 * k, fontWeight: "400", letterSpacing: 0.1 }}>Add to</Text>
            <Text allowFontScaling={false} style={{ color: "#FFFFFF", fontSize: 19 * k, lineHeight: 22 * k, fontWeight: "600", letterSpacing: -0.3 }}>Apple Wallet</Text>
          </View>
        </>
      )}
    </Pressable>
  );
}
