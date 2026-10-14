import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { moneyLabel, type MRegistration } from "@core";
import { errorMessage } from "../api/client";
import { registrationAction, useMyRegistrations } from "../api/queries";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card, Chip, Empty } from "../ui/Bits";
import { LoadState } from "../ui/LoadState";
import { openTournament } from "../nav/links";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null);

/** My registrations (Phase 9): status, what is paid and due, pay / cancel / ask for a refund. */
function Row({ r }: { r: MRegistration }) {
  const { t } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const act = async (kind: "pay" | "cancel" | "refund-request") => {
    setBusy(kind);
    setMsg(null);
    try {
      const out = await registrationAction(r.id, kind);
      if (out.checkoutUrl) await WebBrowser.openBrowserAsync(out.checkoutUrl);
      setMsg({ text: out.message });
    } catch (e) {
      setMsg({ text: errorMessage(e), bad: true });
    } finally {
      setBusy(null);
    }
  };
  const money = [
    r.amountOnline ? `${moneyLabel(r.amountOnline)} online${r.paid ? " · paid" : ""}` : null,
    r.amountVenue ? `${moneyLabel(r.amountVenue)} at the venue${r.venuePaid ? " · paid" : ""}` : null,
  ].filter(Boolean);
  return (
    <Card style={{ gap: 6, borderColor: r.status === "confirmed" ? t.ball : t.line, borderWidth: r.status === "confirmed" ? 1.5 : 1 }} onPress={() => openTournament(r.event.slug)} accessibilityLabel={`${r.event.name}. ${r.statusLabel}`}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Chip label={r.statusLabel} ball={r.status === "confirmed"} />
        {r.event.organization ? <Eyebrow size={10}>{r.event.organization.name}</Eyebrow> : null}
      </View>
      <Body weight="bold" size={16}>{r.event.name}</Body>
      <Body tone="ink2" size={13}>{[r.teamName, r.people.map((p) => p.name).join(" / ")].filter(Boolean).join(" · ")}</Body>
      {money.length ? <Body tone="ink2" size={13}>{money.join(" · ")}</Body> : <Body tone="ink2" size={13}>Free</Body>}
      {r.status === "awaiting_payment" && r.canPay ? <Body tone="ink3" size={12}>Only paid entries hold a place: your place is confirmed when your payment goes through.</Body> : null}
      {r.linked ? <Body tone="ink3" size={12}>Linked to your account: your matches show up in the app.</Body> : null}
      {r.refundRequested ? <Body tone="ink3" size={12}>Refund asked for: the organiser decides.</Body> : null}
      {r.paid && r.refundsUntil && !r.refundRequested && r.status === "confirmed" ? <Body tone="ink3" size={12}>{`Full refunds until ${day(r.refundsUntil)}.`}</Body> : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {r.canPay ? <Button label={busy === "pay" ? "Opening…" : `Pay ${moneyLabel(r.amountOnline)}`} disabled={Boolean(busy)} onPress={() => void act("pay")} /> : null}
        {r.canRequestRefund ? <Button kind="ghost" label="Ask for a refund" disabled={Boolean(busy)} onPress={() => void act("refund-request")} /> : null}
        {r.canCancel ? <Button kind="ghost" label="Cancel" disabled={Boolean(busy)} onPress={() => void act("cancel")} /> : null}
      </View>
      {msg ? <Body tone={msg.bad ? "live" : "ink2"} size={13} accessibilityLiveRegion="polite">{msg.text}</Body> : null}
    </Card>
  );
}

export default function MyRegistrations() {
  const user = session.use((s) => s.user);
  const q = useMyRegistrations(Boolean(user));
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label="My profile" fallback="/profile" />
      <Display size={28}>Registrations</Display>
      {!user ? (
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body tone="ink2">Sign in to see your registrations.</Body>
          <Button kind="ghost" label="Account" onPress={() => router.replace("/account")} />
        </Card>
      ) : q.data ? (
        <View style={{ gap: 10, marginTop: 14 }}>
          {q.data.registrations.length ? q.data.registrations.map((r) => <Row key={r.id} r={r} />) : <Empty title="No registrations yet" body="Register for a tournament from its page." />}
        </View>
      ) : (
        <LoadState queries={[q]} what="your registrations" />
      )}
    </Screen>
  );
}
