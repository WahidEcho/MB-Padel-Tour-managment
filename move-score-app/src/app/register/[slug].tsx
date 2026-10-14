import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { charges, moneyLabel, PAYMENT_FAILED_MESSAGE, type MPaymentChoice, type MRegistrationInfo } from "@core";
import { ApiError, errorMessage } from "../../api/client";
import { registerFor, registrationAction, useMyRegistrations, useRegistrationInfo } from "../../api/queries";
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
const CHOICE_LABEL: Record<MPaymentChoice, string> = { online: "Pay now (card)", venue: "Pay at the venue", free: "Free" };

/**
 * Register for an event (Phase 9): announce → register → pay → confirmation.
 * The registrant is always the signed-in account's own player (the server uses
 * the linked player's name); partners are typed here and are never linked to
 * this account. First paid, first in (the default): registering holds no place;
 * Pay opens the online checkout in the browser (which keeps a place for a few
 * minutes) and the entry is confirmed when the payment goes through. An event
 * that takes both lets the player enter on their own (the organiser pairs solo
 * players) or as a team. The entry shows under My registrations.
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

type Kind = "individual" | "team";

function RegisterForm({ info }: { info: MRegistrationInfo }) {
  const kinds: Kind[] = info.entryKinds?.length ? info.entryKinds : [info.entryType === "individual" ? "individual" : "team"];
  const [kind, setKind] = useState<Kind>(kinds[0]!);
  const count = kind === "team" ? info.people : 1;
  const [all, setAll] = useState(() => Array.from({ length: Math.max(1, info.people) }, () => ({ name: "", phone: "", email: "" })));
  const people = all.slice(0, count);
  const [teamName, setTeamName] = useState("");
  const [choice, setChoice] = useState<MPaymentChoice>(info.paymentOptions[0] ?? "free");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const cost = charges({ feeAmount: info.feePerPlayer, teamPayer: info.teamPayer, entryType: kind, teamSize: info.people }, choice, count);
  const set = (i: number, k: "name" | "phone" | "email", v: string) => setAll((p) => p.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  const submit = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await registerFor(info.event.slug, {
        people: people.map((p, i) => ({ name: p.name.trim(), ...(p.phone.trim() ? { phone: p.phone.trim() } : {}), ...(i === 0 && p.email.trim() ? { email: p.email.trim() } : {}) })),
        ...(kind === "team" && teamName.trim() ? { teamName: teamName.trim() } : {}),
        ...(info.entryType === "both" ? { entryType: kind } : {}),
        payment: choice,
      });
      setMsg({ text: r.message });
      // Registering holds no place: paying does. Open the checkout straight away (the place is kept while it is open).
      if (r.registration.canPay) {
        try {
          const pay = await registrationAction(r.registration.id, "pay");
          if (pay.checkoutUrl) await WebBrowser.openBrowserAsync(pay.checkoutUrl);
        } catch (e) {
          setMsg({ text: errorMessage(e), bad: true });
          return;
        }
      }
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
      {kinds.length > 1 ? (
        <Segments<Kind> value={kind} onChange={setKind} options={kinds.map((k) => ({ key: k, label: k === "team" ? `Team of ${info.people}` : "On my own" }))} />
      ) : null}
      {kind === "individual" && kinds.includes("team") ? <Body tone="ink3" size={12}>The organiser pairs players who enter on their own.</Body> : null}
      {kind === "team" ? <Field label="Team name (optional)" value={teamName} onChange={setTeamName} /> : null}
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
          {info.approval === "organiser" && cost.online ? " (you pay after the organiser approves; an approved entry keeps its place for 24 hours while it is paid)" : ""}
          {info.approval === "on_payment" && cost.online ? ". Only paid entries hold a place: yours is confirmed when your payment goes through." : ""}
        </Body>
      ) : null}
      <Body tone="ink3" size={12}>Your name and the contact details you enter are shared with the organiser.</Body>
      <Button label={busy ? "Registering…" : cost.online && info.approval === "on_payment" ? `Register and pay ${moneyLabel(cost.online)}` : "Register"} disabled={busy || people.some((p, i) => p.name.trim().length < 2 || (i === 0 && p.phone.trim().length < 8))} onPress={() => void submit()} />
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
        <Body size={14}>{info.entryType === "team" ? `Teams of ${info.people}` : info.entryType === "both" ? `On your own, or as a team of ${info.people}` : "Individual entry"}</Body>
        <Body size={14}>{info.feeLabel ?? "Free"}{info.feeLabel && info.entryType !== "individual" ? (info.teamPayer === "registrant" ? " · a team's registrant pays for the team" : " · each pays their share") : ""}</Body>
        <Body tone="ink2" size={13}>
          {info.approval === "organiser"
            ? info.paymentOptions.includes("online")
              ? "The organiser approves each entry; an approved entry keeps its place for 24 hours while it is paid."
              : "The organiser approves each entry."
            : info.paymentOptions.includes("online")
              ? "First paid, first in: your place is confirmed when your payment goes through."
              : "First come, first in while places remain."}
          {info.placesLeft !== null && info.placesLeft !== undefined ? ` ${info.placesLeft} place${info.placesLeft === 1 ? "" : "s"} left.` : ""}
        </Body>
        {info.feePerPlayer > 0 ? <Body tone="ink2" size={13}>{`Full refunds until ${when(info.refundsUntil)}.`}</Body> : null}
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
            {existing.status === "awaiting_payment" && existing.paymentFailed ? (
              <Body tone="live" size={13} weight="bold" accessibilityLiveRegion="polite">
                {PAYMENT_FAILED_MESSAGE}
              </Body>
            ) : null}
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
