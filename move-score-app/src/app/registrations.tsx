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
import { useT } from "../i18n";
import { awaitingNote, day, paymentLines, registrationStatus } from "../player/registration";



/** My registrations (Phase 9): status, what is paid and due, pay / cancel / ask for a refund. */
function Row({ r }: { r: MRegistration }) {
  const { t } = useTheme();
  const tr = useT();
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
  // Older servers send no payments: fall back to "online · paid".
  const online = r.payments
    ? paymentLines(r.amountOnline, r.payments)
    : r.amountOnline
      ? [r.paid ? tr("account.payOnlinePaid", { amount: moneyLabel(r.amountOnline) }) : tr("account.payOnline", { amount: moneyLabel(r.amountOnline) })]
      : [];
  const money = [...online, r.amountVenue ? (r.venuePaid ? tr("account.payVenuePaid", { amount: moneyLabel(r.amountVenue) }) : tr("account.payVenue", { amount: moneyLabel(r.amountVenue) })) : null].filter(Boolean);
  const status = registrationStatus(r);
  return (
    <Card style={{ gap: 6, borderColor: r.status === "confirmed" ? t.ball : t.line, borderWidth: r.status === "confirmed" ? 1.5 : 1 }} onPress={() => openTournament(r.event.slug)} accessibilityLabel={`${r.event.name}. ${status}`}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Chip label={status} ball={r.status === "confirmed"} />
        {r.event.organization ? <Eyebrow size={10}>{r.event.organization.name}</Eyebrow> : null}
      </View>
      <Body weight="bold" size={16}>{r.event.name}</Body>
      <Body tone="ink2" size={13}>{[r.teamName, r.people.map((p) => p.name).join(" / ")].filter(Boolean).join(" · ")}</Body>
      {money.length ? <Body tone="ink2" size={13}>{money.join(" · ")}</Body> : <Body tone="ink2" size={13}>{tr("account.free")}</Body>}
      {r.status === "awaiting_payment" && r.paymentFailed ? (
        <Body tone="live" size={13} weight="bold" accessibilityLiveRegion="polite">
          {tr("account.paymentFailed")}
        </Body>
      ) : null}
      {r.status === "awaiting_payment" && r.canPay ? (
        <Body tone="ink3" size={12}>{awaitingNote({ approved: Boolean(r.approved), holdUntil: r.placeKeptUntil ?? null })}</Body>
      ) : null}
      {r.linked ? <Body tone="ink3" size={12}>{tr("account.regLinked")}</Body> : null}
      {r.refundRequested ? <Body tone="ink3" size={12}>{tr("account.refundAsked")}</Body> : null}
      {r.paid && r.refundsUntil && !r.refundRequested && r.status === "confirmed" ? <Body tone="ink3" size={12}>{tr("account.refundsUntil", { when: day(r.refundsUntil) ?? "" })}</Body> : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {r.canPay ? <Button label={busy === "pay" ? tr("account.opening") : tr("account.payAmount", { amount: moneyLabel(r.amountOnline) })} disabled={Boolean(busy)} onPress={() => void act("pay")} /> : null}
        {r.canRequestRefund ? <Button kind="ghost" label={tr("account.askRefund")} disabled={Boolean(busy)} onPress={() => void act("refund-request")} /> : null}
        {r.canCancel ? <Button kind="ghost" label={tr("common.cancel")} disabled={Boolean(busy)} onPress={() => void act("cancel")} /> : null}
      </View>
      {msg ? <Body tone={msg.bad ? "live" : "ink2"} size={13} accessibilityLiveRegion="polite">{msg.text}</Body> : null}
    </Card>
  );
}

export default function MyRegistrations() {
  const tr = useT();
  const user = session.use((s) => s.user);
  const q = useMyRegistrations(Boolean(user));
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label={tr("player.myProfile")} fallback="/profile" />
      <Display size={28}>{tr("account.registrations")}</Display>
      {!user ? (
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body tone="ink2">{tr("account.signInRegistrations")}</Body>
          <Button kind="ghost" label={tr("ui.account")} onPress={() => router.replace("/account")} />
        </Card>
      ) : q.data ? (
        <View style={{ gap: 10, marginTop: 14 }}>
          {q.data.registrations.length ? q.data.registrations.map((r) => <Row key={r.id} r={r} />) : <Empty title={tr("account.noRegistrations")} body={tr("account.noRegistrationsBody")} />}
        </View>
      ) : (
        <LoadState queries={[q]} what={tr("account.yourRegistrations")} />
      )}
    </Screen>
  );
}
