/**
 * Form pieces for the email screens: a labelled text field, a password field
 * with show/hide, and the live password checklist (the same rules the server
 * enforces, from @core).
 */
import { useState } from "react";
import { Pressable, TextInput, View, type TextInputProps } from "react-native";
import { LISTED_RULES, passwordChecks } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "../ui/Text";

type FieldProps = Omit<TextInputProps, "style"> & { label: string; error?: boolean; right?: React.ReactNode };

export function Field({ label, error, right, ...input }: FieldProps) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Body weight="semi" size={13}>{label}</Body>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: t.chip,
          borderColor: error ? t.live : t.line,
          borderWidth: 1,
          borderRadius: 14,
          paddingHorizontal: 14,
        }}
      >
        <TextInput
          placeholderTextColor={t.ink3}
          accessibilityLabel={label}
          {...input}
          style={{ flex: 1, color: t.ink, fontSize: 16, paddingVertical: 14 }}
        />
        {right}
      </View>
    </View>
  );
}

export function EmailField(props: Omit<FieldProps, "label"> & { label?: string }) {
  return (
    <Field
      label={props.label ?? "Email"}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="email"
      keyboardType="email-address"
      textContentType="emailAddress"
      inputMode="email"
      placeholder="you@example.com"
      {...props}
    />
  );
}

/** A password field with a Show/Hide toggle. `isNew` sets the keyboard's new-password hints. */
export function PasswordField({ isNew, label = "Password", ...props }: Omit<FieldProps, "label" | "right"> & { label?: string; isNew?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <Field
      label={label}
      secureTextEntry={!shown}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete={isNew ? "new-password" : "current-password"}
      textContentType={isNew ? "newPassword" : "password"}
      {...props}
      right={
        <Pressable onPress={() => setShown((s) => !s)} accessibilityRole="button" accessibilityLabel={shown ? "Hide password" : "Show password"} hitSlop={10} style={{ paddingLeft: 10, paddingVertical: 8 }}>
          <Body tone="blue" weight="semi" size={13}>{shown ? "Hide" : "Show"}</Body>
        </Pressable>
      }
    />
  );
}

/** The rules, ticked as they are met. Limits that are rarely hit appear only when broken. */
export function PasswordChecklist({ password, email }: { password: string; email?: string | null }) {
  const checks = passwordChecks(password, email).filter((c) => LISTED_RULES.includes(c.rule) || !c.ok);
  return (
    <View accessibilityRole="summary" accessibilityLabel="Password rules" style={{ gap: 4 }}>
      {checks.map((c) => (
        <Body key={c.rule} tone={c.ok ? "ink" : password ? "live" : "ink3"} size={12.5} accessibilityLabel={`${c.label}: ${c.ok ? "done" : "not yet"}`}>
          {`${c.ok ? "✓" : "○"}  ${c.label}`}
        </Body>
      ))}
    </View>
  );
}
