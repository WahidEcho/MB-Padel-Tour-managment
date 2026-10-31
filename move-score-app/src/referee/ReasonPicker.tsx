/**
 * The chair umpire's two call buttons (owner, 31 Oct 2026; migration 0044): "Call Referee for Rule"
 * and "Call Referee for Medical". Each sends the call at once with its reason; the master referees'
 * alert says it first. Words shared through @core (src/lib/referees/callWords.ts).
 */
import { View } from "react-native";
import { ASSISTANCE_REASONS, type AssistanceReason } from "@core";
import { Button } from "../ui/Bits";
import { Glyph } from "../ui/Glyph";
import { useT } from "../i18n";
import { ct } from "./callText";

export function ReasonPicker({ busy = false, onSend, onCancel }: { busy?: boolean; onSend: (reason: AssistanceReason) => void; onCancel?: () => void }) {
  useT(); // re-render when the app language changes
  return (
    <View style={{ gap: 8 }} testID="reason-picker">
      {ASSISTANCE_REASONS.map((r) => (
        <Button
          key={r}
          kind="danger"
          label={busy ? ct("calling") : ct(`callFor_${r}`)}
          icon={busy ? undefined : <Glyph name="help" color="#FFFFFF" size={20} />}
          disabled={busy}
          onPress={() => onSend(r)}
          accessibilityLabel={ct(`callFor_${r}`)}
        />
      ))}
      {onCancel ? <Button kind="ghost" label={ct("cancel")} disabled={busy} onPress={onCancel} /> : null}
    </View>
  );
}
