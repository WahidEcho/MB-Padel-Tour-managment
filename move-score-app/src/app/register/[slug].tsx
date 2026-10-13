import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { charges, moneyLabel, type MPaymentChoice, type MRegistrationInfo } from "@core";
import { ApiError, errorMessage } from "../../api/client";
import { registerFor, useMyRegistrations, useRegistrationInfo } from "../../api/queries";
import { session } from "../../state/session";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Empty } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { Segments } from "../../ui/Segments";
import { openRegistrations } from "../../nav/links";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "to be confirmed");
const CHOICE_LABEL: Record<MPaymentChoice, string> = { online: "Pay now (Move Tick)", venue: "Pay at the venue", free: "Free" };

/**
 * Register for an event (Phase 9): announce → register → pay → confirmation.
 * The registrant is always the signed-in account's own player (the server uses
 * the linked player's name); partners are typed here and are never linked to
 * this account. Online payment opens Move Tick's checkout in the browser; the
 * entry shows under My registrations.
 */
function Field({ label, value, onChange, keyboard, auto }: { label: string; value: string; onChange: (s: string) => void; keyboard?: "phone-pad" | "email-address"; auto?: "name" | "tel" | "email" | "off" }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Body tone="ink2" size={12.5}>{label}</Body>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={keyboard ?? "default"}
        autoComplete={auto ?? "off"}
        autoCapitalize={keyboard ? "none" : "words"}
        accessibilityLabel={label}
        placeholderTextColor={t.ink3}
        style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: t.ink, fontSize: 16 }}
      />
    </View>
  );
}

function RegisterForm({ info }: { info: MRegistrationInfo }) {
  const [people, setPeople] = useState(() => Array.from({ length: info.people }, () => ({ name: "", phone: "", email: "" })));
  const [teamName, setTeamName] = useState("");
  const [choice, setChoice] = useState<MPaymentChoice>(info.paymentOptions[0] ?? "free");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const cost = charges({ feeAmount: info.feePerPlayer, teamPayer: info.teamPayer, entryType: info.entryType, teamSize: info.people }, choice, info.people);
  const set = (i: number, k: "name" | "phone" | "email", v: string) => setPeople((p) => p.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  const submit = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await registerFor(info.event.slug, {
        people: people.map((p, i) => ({ name: p.name.trim(), ...(p.phone.trim() ? { phone: p.phone.trim() } : {}), ...(i === 0 && p.email.trim() ? { email: p.email.trim() } : {}) })),
        ...(info.entryType === "team" && teamName.trim() ? { teamName: teamName.trim() } : {}),
        payment: choice,
      });
      setMsg({ text: r.message });
      if (r.checkoutUrl) await WebBrowser.openBrowserAsync(r.checkoutUrl);
      openRegistrations();
    } catch (e) {
      if (e instanceof ApiError && (e.body as { code?: string } | null)?.code === "already_registered") openRegistrations();
      setMsg({ text: errorMessage(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: 12 }}>
      {info.entryType === "team" ? <Field label="Team name (optional)" value={teamName} onChange={setTeamName} /> : null}
      {people.map((p, i) => (
        <View key={i} style={{ gap: 8 }}>
          <Eyebrow size={10}>{i === 0 ? "You" : `Player ${i + 1}`}</Eyebrow>
          <Field label={i === 0 ? "Your full name" : "Full name"} value={p.name} onChange={(v) => set(i, "name", v)} auto={i === 0 ? "name" : "off"} />
          <Field label={i === 0 || info.event.kind === "session" ? "Mobile" : "Mobile (optional)"} value={p.phone} onChange={(v) => set(i, "phone", v)} keyboard="phone-pad" auto={i === 0 ? "tel" : "off"} />
          {i === 0 ? <Field label="Email (optional, for the confirmation)" value={p.email} onChange={(v) => set(i, "email", v)} keyboard="email-address" auto="email" /> : null}
        </View>
      ))}
      {info.paymentOptions.length > 1 ? (
        <Segments<MPaymentChoice> value={choice} onChange={setChoice} options={info.paymentOptions.map((o) => ({ key: o, label: CHOICE_LABEL[o] }))} />
      ) : null}
      {cost.total > 0 ? (
        <Body tone="ink2" size={13}>
          {[cost.online ? `${moneyLabel(cost.online)} now` : null, cost.venue ? `${moneyLabel(cost.venue)} at the venue` : null].filter(Boolean).join(" + ")}
          {info.approval === "organiser" && cost.online ? " (you pay after the organiser approves)" : ""}
        </Body>
      ) : null}
      <Body tone="ink3" size={12}>Your name and the contact details you enter are shared with the organiser.</Body>
      <Button label={busy ? "Registering…" : "Register"} disabled={busy || people.some((p, i) => p.name.trim().length < 2 || (i === 0 && p.phone.trim().length < 8))} onPress={() => void submit()} />
      {msg ? <Body tone={msg.bad ? "live" : "ink2"} size={13} accessibilityLiveRegion="polite">{msg.text}</Body> : null}
    </Card>
  );
}

function RegisterPage({ slug }: { slug: string }) {
  const user = session.use((s) => s.user);
  const q = useRegistrationInfo(slug);
  const mine = useMyRegistrations(Boolean(user));
  if (!q.data) {
    return (
      <Screen tabs={false} onRefresh={() => q.refetch()}>
        <BackHeader label="Back" />
        <LoadState queries={[q]} what="registration" notFound={<Empty title="No registration here" body="This event doesn't take registrations in Move Score." />} />
      </Screen>
    );
  }
  const info = q.data;
  const existing = mine.data?.registrations.find((r) => r.event.slug === slug && ["pending_approval", "awaiting_payment", "confirmed"].includes(r.status));
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([q.refetch(), user ? mine.refetch() : Promise.resolve()])}>
      <BackHeader label="Back" />
      {info.event.organization ? <Eyebrow>{info.event.organization.name}</Eyebrow> : null}
      <Display size={26} style={{ marginTop: 4 }}>{info.event.name}</Display>
      <Body tone="ink2" size={13} style={{ marginTop: 4 }}>{`Starts ${when(info.event.startsAt)}`}</Body>
      <Card style={{ gap: 4, marginTop: 14 }}>
        <Body size={14}>{info.entryType === "team" ? `Teams of ${info.people}` : "Individual entry"}</Body>
        <Body size={14}>{info.feeLabel ?? "Free"}{info.feeLabel && info.entryType === "team" ? (info.teamPayer === "registrant" ? " · you pay for the team" : " · each pays their share") : ""}</Body>
        <Body tone="ink2" size={13}>{info.approval === "organiser" ? "The organiser approves each entry." : "Entries are accepted straight away."}</Body>
        {info.feePerPlayer > 0 ? <Body tone="ink2" size={13}>{`Refunds until ${when(info.refundsUntil)}${info.refundFeePercent ? `, less ${info.refundFeePercent}%` : ""}.`}</Body> : null}
        {info.note ? <Body tone="ink2" size={13}>{info.note}</Body> : null}
      </Card>
      <View style={{ marginTop: 14 }}>
        {!info.open ? (
          <Card>
            <Body tone="ink2">{info.closedMessage ?? "Registration is not open."}</Body>
          </Card>
        ) : !user ? (
          <Card style={{ gap: 10 }}>
            <Body tone="ink2" size={13}>Sign in to register: your entry and your player code arrive in your account.</Body>
            <Button label="Sign in" onPress={() => router.push("/account")} />
          </Card>
        ) : existing ? (
          <Card style={{ gap: 10 }}>
            <Body weight="bold">{existing.statusLabel}</Body>
            <Button label="My registrations" onPress={openRegistrations} />
          </Card>
        ) : (
          <RegisterForm info={info} />
        )}
      </View>
    </Screen>
  );
}

export default function RegisterScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const key = useMemo(() => slug ?? "", [slug]);
  return <RegisterPage slug={key} />;
}
