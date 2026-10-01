import { HStack, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, padding } from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";

/** Must match the server's content state (src/lib/notify/apns.ts): name "MatchScore". */
export type MatchScoreProps = {
  a: string;
  b: string;
  sets: string;
  points: string;
  serving: "A" | "B" | null;
  status: string;
  court: string;
};

const MatchScore = (p: MatchScoreProps, env: LiveActivityEnvironment) => {
  "widget";
  const yellow = env.isLuminanceReduced ? "#FFFFFF" : "#FCFC00";
  const ink = "#E8ECF4";
  const dim = "#9AA4B8";
  const dotA = p.serving === "A" ? "● " : "";
  const dotB = p.serving === "B" ? " ●" : "";
  return {
    banner: (
      <VStack modifiers={[padding({ all: 14 })]}>
        <HStack>
          <Text modifiers={[font({ weight: "heavy", size: 13 }), foregroundStyle(yellow)]}>MOVE SCORE</Text>
          <Spacer />
          <Text modifiers={[font({ size: 12 }), foregroundStyle(dim)]}>{`${p.status}${p.court ? ` · ${p.court}` : ""}`}</Text>
        </HStack>
        <HStack>
          <Text modifiers={[font({ weight: "bold", size: 22 }), foregroundStyle(ink)]}>{`${dotA}${p.a}`}</Text>
          <Spacer />
          <Text modifiers={[font({ weight: "black", size: 26 }), foregroundStyle(yellow)]}>{p.points}</Text>
          <Spacer />
          <Text modifiers={[font({ weight: "bold", size: 22 }), foregroundStyle(ink)]}>{`${p.b}${dotB}`}</Text>
        </HStack>
        <Text modifiers={[font({ size: 14 }), foregroundStyle(dim)]}>{p.sets}</Text>
      </VStack>
    ),
    compactLeading: <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(yellow)]}>{p.a}</Text>,
    compactTrailing: <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(ink)]}>{p.points || p.sets}</Text>,
    minimal: <Text modifiers={[font({ weight: "heavy", size: 12 }), foregroundStyle(yellow)]}>{p.points ? p.points.split("-")[0] : "●"}</Text>,
    expandedLeading: (
      <VStack modifiers={[padding({ all: 8 })]}>
        <Text modifiers={[font({ weight: "bold", size: 18 }), foregroundStyle(ink)]}>{`${dotA}${p.a}`}</Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack modifiers={[padding({ all: 8 })]}>
        <Text modifiers={[font({ weight: "bold", size: 18 }), foregroundStyle(ink)]}>{`${p.b}${dotB}`}</Text>
      </VStack>
    ),
    expandedCenter: <Text modifiers={[font({ weight: "black", size: 24 }), foregroundStyle(yellow)]}>{p.points}</Text>,
    expandedBottom: <Text modifiers={[font({ size: 13 }), foregroundStyle(dim)]}>{`${p.sets}${p.court ? ` · ${p.court}` : ""}`}</Text>,
  };
};

export default createLiveActivity<MatchScoreProps>("MatchScore", MatchScore);
