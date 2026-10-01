import { Tabs } from "expo-router/js-tabs";
import { TabBar } from "../../ui/TabBar";

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: "transparent" } }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="matches" />
      <Tabs.Screen name="pass" />
      <Tabs.Screen name="players" />
      <Tabs.Screen name="following" />
    </Tabs>
  );
}
