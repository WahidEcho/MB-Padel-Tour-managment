/**
 * The PIN step's name picker (audit H1): after the court code the referee picks their
 * own name (searchable, with a photo when the organiser added one); the server then
 * checks the PIN against that referee only. Names and photos only, never a phone.
 */
import { useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { filterRefereeChoices, type RefereeChoice } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "../ui/Text";
import { useT } from "../i18n";

export function RefereeNamePicker({ referees, selected, onSelect }: { referees: RefereeChoice[]; selected: string | null; onSelect: (id: string) => void }) {
  const { t } = useTheme();
  const tr = useT();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterRefereeChoices(referees, query), [referees, query]);
  return (
    <View style={{ gap: 8 }}>
      {referees.length > 6 ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={tr("referee.searchName")}
          placeholderTextColor={t.ink3}
          autoCorrect={false}
          accessibilityLabel={tr("referee.searchName")}
          style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: t.ink, fontSize: 16 }}
        />
      ) : null}
      <View accessibilityRole="radiogroup" style={{ gap: 6 }}>
        {shown.map((r) => {
          const on = r.id === selected;
          return (
            <Pressable
              key={r.id}
              onPress={() => onSelect(r.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={r.name}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: 14, borderWidth: 1, borderColor: on ? t.blue : t.line, backgroundColor: on ? t.chip : "transparent" }}
            >
              {r.photoUrl ? (
                <Image source={{ uri: r.photoUrl }} style={{ width: 36, height: 36, borderRadius: 18 }} contentFit="cover" accessibilityIgnoresInvertColors />
              ) : (
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: t.chip, alignItems: "center", justifyContent: "center" }}>
                  <Body weight="bold" size={13}>{r.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</Body>
                </View>
              )}
              <Body weight={on ? "bold" : undefined} size={16}>{r.name}</Body>
            </Pressable>
          );
        })}
        {shown.length === 0 ? <Body tone="ink3" size={13}>{tr("referee.noRefereeNamed")}</Body> : null}
      </View>
    </View>
  );
}
