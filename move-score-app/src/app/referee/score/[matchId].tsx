import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, TextInput, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useKeepAwake } from "expo-keep-awake";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Console,
  chessCompetitionFor,
  enteredSetsFromState,
  finalResultAllowed,
  queueableResult,
  OFFENCE_LABELS,
  currentServer,
  servingPlayer,
  namedReceiver,
  aceMoment,
  defaultServeOrder,
  lockServeOrder,
  tossDecidesServer,
  needsServeOrder,
  nationByCode,
  sidesSwapped,
  type LogEntry,
  type TimeDecision,
  type TimerKind,
  type ResultPayload,
  type ResultProblem,
  type ScoreState,
  type TeamKey,
} from "@core";
import { api, ApiError } from "../../../api/client";
import { config } from "../../../config";
import { session, saveStaff } from "../../../state/session";
import { SchemeScope, useTheme } from "../../../theme/ThemeProvider";
import { getJson, setJson } from "../../../state/kv";
import { useConsole } from "../../../referee/useConsole";
import { useLease } from "../../../referee/useLease";
import type { RefereeBootstrap } from "../../../referee/types";
import type { SyncState } from "../../../referee/sync";
import { useCall } from "../../../referee/useCall";
import { AssistanceCard, requestAssistance } from "../../../referee/AssistanceCard";
import { BetweenPoints, MatchLogList, PadV2, ServeOrderForm, TimerCard, useTick, type V2Side } from "../../../referee/V2";
import { BALL, BALL_INK } from "../../../theme/palette";
import { LineupScreenBody } from "../../../referee/LineupScreen";
import { signInWithCode } from "../../../referee/courtSignIn";
import { RefereeNamePicker } from "../../../referee/RefereeNamePicker";
import type { RefereeChoice } from "@core";
import { CallCard } from "../../../referee/CallCard";
import { FinalScore } from "../../../referee/FinalScore";
import { Sheet as Sheetish } from "../../../referee/Sheet";
import { chessEntry } from "../../../referee/chessResult";
import { Body, Display, Eyebrow, Num } from "../../../ui/Text";
import { Button, Card, Chip, Flag } from "../../../ui/Bits";
import { BackHeader } from "../../../ui/Header";
import { LoadState, type LoadQuery } from "../../../ui/LoadState";
import { Glyph, type GlyphName } from "../../../ui/Glyph";
import { useT } from "../../../i18n";
import { fmt } from "../../../i18n/t";
import { offenceLabel, penaltyLabel, problemText, rulesText, timerLabel, winWhat } from "../../../referee/scoreWords";

type Sheet =
  | { kind: "confirm-point"; team: TeamKey; what: string }
  | { kind: "more" }
  | { kind: "violation"; team: TeamKey | null }
  | { kind: "end"; event: "FORCE_END" | "WALKOVER" | "RETIREMENT" | "DISQUALIFICATION" | "SET" }
  | { kind: "handover" }
  | { kind: "conflict" }
  | { kind: "reopen" }
  | { kind: "code" }
  | { kind: "result" }
  | { kind: "let" }
  | { kind: "call" }
  | { kind: "log" }
  | { kind: "break-team"; timer: TimerKind }
  | { kind: "time-team"; decision: TimeDecision }
  | { kind: "confirm-v2"; action: "ace" | "fault"; team: TeamKey; what: string }
  | null;

/** The final-result form: where it starts from, and the last refusal. */
interface ResultForm {
  correcting: boolean;
  initial: ResultPayload | null;
  /** Bumped each time the form opens, so it starts from `initial` again. */
  key: number;
}

/** Statuses the server holds as over. */
const SERVER_FINISHED = ["completed", "walkover", "disqualified", "retired", "cancelled"];
const DAY_MS = 24 * 60 * 60 * 1000;
/** Ends the screen names in words ("Ended: retirement."). */
const ENDED_STATUS = ["walkover", "retired", "disqualified", "cancelled"];

function SyncPill({ s, online }: { s: SyncState; online: boolean }) {
  const { t } = useTheme();
  const tr = useT();
  const n = "pending" in s ? s.pending : 0;
  const [label, color] =
    s.kind === "conflict"
      ? [s.reason === "device_lock" ? tr("score.syncOtherPhone") : tr("score.syncProblem"), t.live]
      : s.kind === "signed_out"
        ? [tr("score.syncSignIn"), t.live]
        : !online || s.kind === "offline"
          ? [tr("score.syncOffline", { count: n }), t.warning]
          : s.kind === "syncing"
            ? [tr("score.syncSending", { count: n }), t.blue]
            : n > 0
              ? [tr("score.syncWaiting", { count: n }), t.warning]
              : [tr("score.syncAllSaved"), t.success];
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: t.chip }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Body weight="bold" size={12} style={{ color }}>{label}</Body>
    </View>
  );
}

/**
 * Re-enters the referee code without leaving the match: the points on this phone stay
 * queued. A court code then asks for the referee's PIN too (migration 0035).
 */
function StaffCodeForm({ onDone, note }: { onDone?: () => void; note?: string }) {
  const { t } = useTheme();
  const tr = useT();
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [needPin, setNeedPin] = useState(false);
  // The names on the code (audit H1): the referee picks theirs before the PIN.
  const [referees, setReferees] = useState<RefereeChoice[]>([]);
  const [refereeId, setRefereeId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const r = await signInWithCode(code.trim(), needPin ? pin : undefined, needPin && referees.length ? refereeId : null);
    setBusy(false);
    if (r.ok) {
      setCode("");
      setPin("");
      setNeedPin(false);
      onDone?.();
      return;
    }
    if (r.pinRequired || r.wrongPin) setNeedPin(true);
    if (r.referees?.length) {
      setReferees(r.referees);
      if (r.referees.length === 1) setRefereeId(r.referees[0].id);
    }
    setPin("");
    setErr(r.pinRequired && !needPin ? tr("score.codePickName", { court: r.court ?? tr("score.thisCode") }) : r.message);
  };
  const input = { backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 14, color: t.ink, fontSize: 18 } as const;
  return (
    <View style={{ gap: 10 }}>
      {note ? <Body tone="ink2" size={13}>{note}</Body> : null}
      <TextInput
        value={code}
        onChangeText={setCode}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={tr("score.codePlaceholder")}
        placeholderTextColor={t.ink3}
        accessibilityLabel={tr("score.codeA11y")}
        onSubmitEditing={() => void submit()}
        style={input}
      />
      {needPin && referees.length > 0 ? <RefereeNamePicker referees={referees} selected={refereeId} onSelect={setRefereeId} /> : null}
      {needPin && (
        <TextInput
          value={pin}
          onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 4))}
          secureTextEntry
          keyboardType="number-pad"
          maxLength={4}
          placeholder={tr("score.pinPlaceholder")}
          placeholderTextColor={t.ink3}
          accessibilityLabel={tr("score.pinA11y")}
          onSubmitEditing={() => void submit()}
          style={{ ...input, letterSpacing: 8, textAlign: "center" }}
        />
      )}
      {err ? <Body tone="live" size={13}>{err}</Body> : null}
      <Button label={busy ? tr("score.checking") : tr("score.signInAgain")} disabled={!code || busy || (needPin && (pin.length !== 4 || (referees.length > 0 && !refereeId)))} onPress={() => void submit()} />
    </View>
  );
}

function pointText(s: ScoreState | null, k: TeamKey) {
  if (!s) return "0";
  if (s.isTiebreak) return String(k === "A" ? s.teamA.tiebreakPoints : s.teamB.tiebreakPoints);
  return k === "A" ? s.teamA.points : s.teamB.points;
}

function ConsoleScreen({ boot, deviceId, sunlight, setSunlight }: { boot: RefereeBootstrap; deviceId: string; sunlight: boolean; setSunlight: (v: boolean) => void }) {
  useKeepAwake();
  const { t } = useTheme();
  const tr = useT();
  const insets = useSafeAreaInsets();
  const [online, setOnline] = useState(true);
  const c = useConsole(boot, deviceId, online);
  const lease = useLease(boot.match.id, deviceId, false);
  const staff = session.use((s) => s.staff);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [now, setNow] = useState(() => Date.now());
  const [clock, setClock] = useState(() => Date.now());
  const [busy, setBusy] = useState<null | "handover" | "release" | "load">(null);
  const [handNote, setHandNote] = useState<string | null>(null);
  const [expiryAsked, setExpiryAsked] = useState(false);
  const [signedOutSeen, setSignedOutSeen] = useState(false);
  const m = boot.match;
  const A = boot.sideA!;
  const B = boot.sideB!;
  const side = (k: TeamKey) => (k === "A" ? A : B);
  const sync = c.sync;
  const pendingN = "pending" in sync ? sync.pending : 0;
  useEffect(() => setOnline(sync.kind !== "offline"), [sync.kind]);

  // First claim. Offline, this phone trusts itself if it has scored this match
  // (its own copy, or points still to send) — read from the queue, not from
  // the sync state, which has not answered yet at this point.
  useEffect(() => {
    if (!c.ready) return;
    let alive = true;
    void (async () => {
      const mine = await c.hasLocalWork();
      if (!alive) return;
      if (SERVER_FINISHED.includes(boot.match.status) && !boot.reopenState && !mine) return;
      void lease.claim(mine);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.ready]);

  // Each time this phone gains control (a claim, an accepted handover, a
  // re-claim on return), carry on from the server's score, not the one it
  // opened with: another device may have scored meanwhile.
  useEffect(() => {
    if (!c.ready || !lease.isController) return;
    void c.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.ready, lease.isController, lease.gained]);

  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!c.rest) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [c.rest]);

  const expiresAt = staff ? Date.parse(staff.expiresAt) : 0;
  const expired = Boolean(staff) && expiresAt <= clock;
  const expiringSoon = Boolean(staff) && !expired && expiresAt - clock < DAY_MS;

  const readOnly = !lease.isController;
  const raw = (readOnly ? ((lease.snapshot?.snapshot_json as ScoreState | null) ?? c.state) : c.state) as ScoreState | null;
  // A chess state is not a games score: only its winner is read here (the web console plays the moves).
  const shown: ScoreState | null = boot.chess ? null : raw;
  const status = readOnly ? (lease.match?.status ?? c.status) : c.status;
  const winnerKey = (raw as { winner?: TeamKey | null } | null)?.winner ?? null;
  // How this match is recorded (match override → session → match-day rules).
  const mode = boot.scoringMode ?? "point_by_point";
  const resultAllowed = finalResultAllowed(mode);
  const resultOnly = mode === "final_score";
  const organiser = staff?.role === "admin" || staff?.role === "manager";
  const courtReferee = Boolean(staff?.referee && staff.referee.role === "referee" && staff.court);
  const call = useCall(boot, { deviceId, matchStatus: status, onMatchDecided: () => void c.reload() });
  const [form, setForm] = useState<ResultForm | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [resultErr, setResultErr] = useState<{ message: string; problems: ResultProblem[] } | null>(null);
  const [resultBusy, setResultBusy] = useState(false);
  const openForm = (correcting: boolean, initial: ResultPayload | null, err: { message: string; problems: ResultProblem[] } | null = null) => {
    setResultErr(err);
    setFormKey((k) => k + 1);
    setForm({ correcting, initial, key: formKey + 1 });
  };
  // The server refused a result this phone queued: the form again, filled in, with why.
  useEffect(() => {
    if (!c.refusal) return;
    openForm(false, c.refusal.initial, { message: c.refusal.message, problems: c.refusal.problems });
    if (!resultOnly) setSheet({ kind: "result" });
    c.clearRefusal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.refusal]);
  // An offline result (pending_sync) and a final score that needs no confirming both count as finished.
  const finished = Console.isFinished(status, boot.chess ? (raw as ScoreState | null) : shown, c.opts.confirmFirst);
  const awaitingConfirm = c.opts.confirmFirst && Boolean(shown?.matchOver) && !finished;
  const server = shown ? currentServer(shown) : null;
  const servingIdx = shown && c.opts.doubles ? servingPlayer(shown) : null;
  // A refused sign-in asks for the code again, here, keeping the queue.
  const codeSheet = sheet?.kind === "code" || (sync.kind === "signed_out" && !signedOutSeen && sheet === null);
  const closeCode = () => {
    setSignedOutSeen(true);
    setSheet(null);
  };
  const restLeft = c.rest ?Math.max(0, Math.ceil((c.rest.endsAt - now) / 1000)) : 0;

  /* ---------------- scoring v2 ---------------- */
  const f = c.features;
  const pairs = A.players.length >= 2 && B.players.length >= 2;
  const nameOf = (x: typeof A) => (x.nation ? (nationByCode(x.nation)?.name ?? x.nation) : x.name);
  const codeOf = (x: typeof A) =>
    (x.nation ?? x.name.replace(/\(.*?\)/g, "").trim().split(/\s+|\//).filter(Boolean).map((w) => w[0]).join("").slice(0, 4) ?? "").toUpperCase() || "—";
  const v2Sides: Record<TeamKey, V2Side> = {
    A: { name: nameOf(A), code: codeOf(A), players: A.players.map((p) => p.name) },
    B: { name: nameOf(B), code: codeOf(B), players: B.players.map((p) => p.name) },
  };
  const [manualSwap, setManualSwapState] = useState<boolean>(() => getJson(`ms.swap.${m.id}`, false));
  const toggleSwap = () => {
    setManualSwapState(!manualSwap);
    setJson(`ms.swap.${m.id}`, !manualSwap);
  };
  const swapped = sidesSwapped(shown, { auto: f.autoSwap, manual: f.manualSwap && manualSwap });
  const tick = useTick(Boolean(c.timer));
  const askOrder = !readOnly && !finished && f.doublesOrder && pairs && !c.paused && c.state !== null && needsServeOrder(c.state, true);
  const [log, setLog] = useState<{ entries: LogEntry[] | null; error: string | null }>({ entries: null, error: null });
  const openLog = async () => {
    setLog({ entries: null, error: null });
    setSheet({ kind: "log" });
    try {
      const r = await api<{ entries: LogEntry[] }>(`/api/matches/${m.id}/log`, { who: "staff", timeoutMs: 10_000 });
      setLog({ entries: r.entries, error: null });
    } catch (e) {
      setLog({ entries: null, error: e instanceof ApiError && e.status !== 0 ? e.message : tr("score.logNoSignal") });
    }
  };
  const [callNote, setCallNote] = useState<string | null>(null);
  const callMaster = courtReferee && f.callMaster;
  const v2Tap = (action: "ace" | "fault") => {
    if (readOnly || !c.state || c.finished || c.paused) return;
    guard(() => {
      const ask = c.v2Confirm(action);
      if (ask) setSheet({ kind: "confirm-v2", action, team: ask.team, what: ask.what });
      else void (action === "ace" ? c.ace() : c.fault());
    });
  };
  const onDecision = (d: TimeDecision) => {
    if (d === "no_action") void c.decide("no_action", null);
    else setSheet({ kind: "time-team", decision: d });
  };

  /** Every scoring action passes here first: a stuck queue or an expired code is said before the tap, not after. */
  const guard = (fn: () => void) => {
    // Handing over or loading the server's score: a point now would land after control has gone.
    if (busy) return;
    if (sync.kind === "conflict") {
      setSheet({ kind: "conflict" });
      return;
    }
    if (expired && !expiryAsked) {
      setExpiryAsked(true);
      setSheet({ kind: "code" });
      return;
    }
    fn();
  };

  const tap = (k: TeamKey) => {
    if (readOnly || !c.state || c.finished || c.paused) return;
    guard(() => {
      const what = c.needsConfirm(k);
      if (what) setSheet({ kind: "confirm-point", team: k, what });
      else void c.point(k);
    });
  };

  const handOver = async () => {
    setBusy("handover");
    setHandNote(null);
    const ok = await c.drain();
    if (ok) await lease.respond(true);
    else setHandNote(tr("score.handNotSent"));
    setBusy(null);
  };

  const sendAndRelease = async () => {
    setBusy("release");
    setHandNote(null);
    const ok = await c.drain();
    if (ok) {
      await lease.release();
      setSheet(null);
    } else {
      setHandNote(tr("score.releaseKept"));
    }
    setBusy(null);
  };

  const loadServer = async () => {
    setBusy("load");
    const ok = c.blocked && !c.question ? await c.reload() : await c.loadServerScore();
    setBusy(null);
    if (ok) setSheet(null);
    else setHandNote(tr("score.noSignalServer"));
  };

  /**
   * A final result: games results are checked and queued like a point (offline
   * too); a correction of a finished match and chess results go straight to the
   * server (they need a connection).
   */
  const submitResult = async (payload: ResultPayload) => {
    if (busy || resultBusy) return;
    if (sync.kind === "conflict") {
      setResultErr({ message: tr("score.conflictFirst"), problems: [] });
      return;
    }
    setResultBusy(true);
    try {
      let out: { ok: true } | { ok: false; message: string; problems: ResultProblem[] };
      if (boot.chess) {
        const e = chessEntry(payload, { mode, competition: chessCompetitionFor(m.stage), legs: boot.legs ?? 1, organiser });
        out = e.ok ? await c.sendResultNow(e) : { ok: false, message: e.problems[0] ? problemText(e.problems[0]) : tr("score.checkTheResult"), problems: e.problems };
      } else if (finished) {
        const q = queueableResult({ mode, engine: "games", rules: boot.config, payload });
        out = q.ok ? await c.sendResultNow({ payload: q.payload, state: q.state, winner: q.winner }) : { ok: false, message: q.problems[0] ? problemText(q.problems[0]) : tr("score.checkTheScore"), problems: q.problems };
      } else {
        out = await c.enterResult(payload);
      }
      if (out.ok) {
        setForm(null);
        setResultErr(null);
        if (sheet?.kind === "result") setSheet(null);
      } else {
        setResultErr({ message: out.message, problems: out.problems });
      }
    } finally {
      setResultBusy(false);
    }
  };

  const resultEntry = (inline: boolean) => (
    <FinalScore
      key={form?.key ?? formKey}
      engine={boot.chess ? "chess" : "games"}
      rules={boot.config}
      legs={boot.legs ?? 1}
      competition={chessCompetitionFor(m.stage)}
      sideA={A.name}
      sideB={B.name}
      initial={form?.initial ?? null}
      correcting={form?.correcting ?? false}
      canDecideAdvance={organiser && chessCompetitionFor(m.stage) === "knockout"}
      busy={resultBusy || readOnly}
      error={resultErr?.message ?? null}
      problems={resultErr?.problems ?? null}
      note={
        readOnly
          ? tr("score.noteReadOnly")
          : boot.chess || form?.correcting
            ? tr("score.noteDirect")
            : tr("score.noteQueued")
      }
      onSubmit={(p) => void submitResult(p)}
      onCancel={
        inline && !form
          ? undefined
          : () => {
              setForm(null);
              setResultErr(null);
              if (sheet?.kind === "result") setSheet(null);
            }
      }
    />
  );
  const showResultSheet = (correcting: boolean, initial: ResultPayload | null) => {
    openForm(correcting, initial);
    setSheet({ kind: "result" });
  };
  const correctable = resultAllowed && !readOnly && finished && SERVER_FINISHED.includes(status) && pendingN === 0;

  const scoreRow = (k: TeamKey) => {
    const s = side(k);
    const sets = shown?.completedSets ?? [];
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, borderTopWidth: k === "B" ? 1 : 0, borderColor: t.line }}>
        <View style={{ width: 12, alignItems: "center" }}>{server === k && !shown?.matchOver ? <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: t.ball, borderWidth: t.scheme === "light" ? 1.5 : 0, borderColor: t.ballInk }} /> : null}</View>
        <Flag iso2={s.iso2} code={s.nation} size={28} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body weight="bold" size={17} numberOfLines={1}>{v2Sides[k].name}</Body>
          {(() => {
            // Doubles: who serves and who receives this point; aces when the organiser counts them.
            const rcv = shown && pairs && !shown.matchOver ? namedReceiver(shown) : null;
            const srv = shown && pairs && !shown.matchOver ? servingPlayer(shown) : null;
            const who =
              srv?.team === k ? tr("score.servingName", { name: s.players[srv.index]?.name ?? "" }) : rcv?.team === k ? tr("score.receivingName", { name: s.players[rcv.index]?.name ?? "" }) : c.opts.doubles && servingIdx?.team === k ? tr("score.servingName", { name: s.players[servingIdx.index]?.name ?? "" }) : s.players.map((p) => p.name).join(" / ");
            const aces = f.ace && shown?.stats ? shown.stats.aces[k] : 0;
            return <Eyebrow size={10} tone="ink2" numberOfLines={1}>{`${who}${aces ? ` · ${tr("score.aces", { count: aces })}` : ""}`}</Eyebrow>;
          })()}
        </View>
        {sets.map((x, i) => (
          <Num key={i} size={24} tone="ink2" style={{ width: 26, textAlign: "center" }}>{k === "A" ? x.teamAGames : x.teamBGames}</Num>
        ))}
        {!shown?.matchOver && <Num size={26} style={{ width: 28, textAlign: "center" }}>{k === "A" ? (shown?.teamA.games ?? 0) : (shown?.teamB.games ?? 0)}</Num>}
        {!shown?.matchOver && (
          <View style={{ minWidth: 60, height: 50, borderRadius: 12, backgroundColor: t.chip, alignItems: "center", justifyContent: "center" }}>
            <Num size={30}>{pointText(shown, k)}</Num>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.floor, paddingTop: insets.top + 6, paddingHorizontal: 14, paddingBottom: insets.bottom + 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <BackHeader label={boot.courtName} />
        <SyncPill s={sync} online={online} />
      </View>
      {c.timer && c.timer.kind === "between_points" && !readOnly && shown && !shown.matchOver ? (
        <View style={{ marginBottom: 6 }}>
          <BetweenPoints timer={c.timer} now={tick} onDismiss={() => void c.endTimer()} onDecision={onDecision} />
        </View>
      ) : null}
      <Card style={{ paddingVertical: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Eyebrow size={10} numberOfLines={1} style={{ flex: 1 }}>{[m.round_name, boot.tournament.name].filter(Boolean).join(" · ")}</Eyebrow>
          {/* A rubber not started yet: its tie's line-up can still change (with a reason once locked). */}
          {m.tie_id && (status === "scheduled" || status === "ready") && (courtReferee || organiser || staff?.referee?.role === "master_referee") ? (
            <Pressable onPress={() => router.push({ pathname: "/referee/lineup/[matchId]", params: { matchId: m.id } })} accessibilityRole="button" hitSlop={8} style={{ marginRight: 6 }}>
              <Chip label={tr("score.lineup")} />
            </Pressable>
          ) : null}
          <Pressable onPress={() => setSunlight(!sunlight)} accessibilityRole="switch" accessibilityState={{ checked: sunlight }} hitSlop={8}>
            <Chip label={sunlight ? tr("score.sunlightOn") : tr("score.sunlight")} ball={sunlight} icon={<Glyph name="sun" color={sunlight ? t.ballInk : t.ink2} size={13} />} />
          </Pressable>
        </View>
        {scoreRow("A")}
        {scoreRow("B")}
        {/* Which tie-break is on: a normal one (to 7) or the super tie-break (to 10) in place of a final set. */}
        {shown?.isTiebreak && !shown.matchOver ? (
          <View testID={shown.isMatchTiebreak ? "super-tiebreak" : "tiebreak"} style={{ alignSelf: "flex-start", backgroundColor: shown.isMatchTiebreak ? t.live : t.chip, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, marginVertical: 2 }}>
            <Eyebrow size={11} style={{ color: shown.isMatchTiebreak ? "#FFFFFF" : t.ink }}>{shown.isMatchTiebreak ? tr("score.matchTiebreak") : tr("score.tiebreak")}</Eyebrow>
          </View>
        ) : null}
        <Body tone="ink3" size={11}>{rulesText(boot.config)}</Body>
        {f.ace && aceMoment(shown) ? (
          <View testID="ace-moment" style={{ position: "absolute", left: 16, top: -11, backgroundColor: BALL, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
            <Eyebrow size={11} style={{ color: BALL_INK }}>{tr("score.ace")}</Eyebrow>
          </View>
        ) : null}
      </Card>
      {/* A court referee signed in with their PIN can call the master referees (migration 0035). */}
      {courtReferee && (
        <View style={{ marginTop: 8 }}>
          <AssistanceCard matchId={m.id} statusOnly />
        </View>
      )}

      {(expired || expiringSoon) && (
        <Card style={{ marginTop: 10, gap: 6, borderColor: expired ? t.live : t.warning, borderWidth: 1 }}>
          <Body weight="semi">
            {expired
              ? tr("score.codeExpired")
              : tr(expiresAt - clock > 12 * 60 * 60 * 1000 ? "score.codeExpiresTomorrow" : "score.codeExpiresAt", { time: fmt().time(expiresAt) })}
          </Body>
          <Button kind="ghost" label={tr("score.reenterCode")} onPress={() => setSheet({ kind: "code" })} />
        </Card>
      )}

      {/* Control: who is scoring this match. A finished match has nothing to hand over (as on the web). */}
      {readOnly && lease.ready && !finished && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.warning, borderWidth: 1 }}>
          <Body weight="semi">{lease.lostTo ? tr("score.controlMovedTo", { name: lease.lostTo }) : lease.heldByOther ? tr("score.readOnlyScoring", { name: lease.holderLabel }) : tr("score.notScoringYet")}</Body>
          {lease.lostTo ? (
            <Body tone="ink2" size={12.5}>
              {pendingN > 0
                ? tr("score.readOnlyUnsent", { count: pendingN })
                : tr("score.readOnlyNow")}
            </Body>
          ) : null}
          {lease.heldByOther ? (
            <Button label={lease.myRequestPending ? tr("score.waitingReply") : tr("score.requestControl")} kind="ghost" onPress={() => void lease.requestControl()} />
          ) : (
            <Button label={tr("score.takeControl")} onPress={() => void lease.claim()} />
          )}
        </Card>
      )}
      {lease.incomingRequest && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.ball, borderWidth: 2 }}>
          <Body weight="semi">{tr("score.wantsToScore", { name: lease.incomingRequest.deviceLabel ?? tr("score.anotherPhone") })}</Body>
          {pendingN > 0 ? <Body tone="live" size={12.5}>{tr("score.mustSendFirst", { count: pendingN })}</Body> : null}
          {handNote && sheet === null ? <Body tone="live" size={12.5}>{handNote}</Body> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="ghost" label={tr("score.decline")} onPress={() => void lease.respond(false)} style={{ flex: 1 }} />
            {pendingN > 0 && busy !== "handover" ? (
              <Button kind="ghost" label={tr("score.sendNow")} onPress={() => c.syncNow()} style={{ flex: 1 }} />
            ) : (
              <Button label={busy === "handover" ? tr("score.sending") : tr("score.handOver")} disabled={busy !== null || pendingN > 0} onPress={() => void handOver()} style={{ flex: 1 }} />
            )}
          </View>
        </Card>
      )}
      {c.question && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.live, borderWidth: 1 }}>
          <Body weight="semi">{tr("score.unsentMovedOn", { count: c.question.pending })}</Body>
          <Body tone="ink2" size={12.5}>
            {tr("score.eventsMismatch", { first: c.question.first, server: c.question.serverNo })}
          </Body>
          <Button kind="ghost" label={tr("score.keepPhoneScore")} onPress={() => void c.keepLocal()} />
          <Button kind="danger" label={busy === "load" ? tr("common.loading") : tr("score.useServerScore")} disabled={busy !== null} onPress={() => void loadServer()} />
          <Body tone="ink3" size={12}>{tr("score.serverSetsAside")}</Body>
        </Card>
      )}
      {c.blocked && !c.question && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.warning, borderWidth: 1 }}>
          <Body weight="semi">{c.blocked}</Body>
          <Button kind="ghost" label={busy === "load" ? tr("common.loading") : tr("score.loadServerScore")} disabled={busy !== null} onPress={() => void loadServer()} />
        </Card>
      )}
      {c.writeError && !c.question && (
        <Card style={{ marginTop: 10, gap: 6, borderColor: t.live, borderWidth: 1 }}>
          <Body weight="semi" tone="live">{c.writeError}</Body>
          <Body tone="blue" weight="semi" onPress={c.clearWriteError}>{tr("score.dismiss")}</Body>
        </Card>
      )}
      {sync.kind === "conflict" && (
        <Card style={{ marginTop: 10, gap: 6, borderColor: t.live, borderWidth: 1 }}>
          <Body weight="semi">{sync.message}</Body>
          <Body tone="ink2" size={12.5}>{tr("score.conflictPaused")}</Body>
          <Button kind="ghost" label={tr("score.whatNow")} onPress={() => setSheet({ kind: "conflict" })} />
        </Card>
      )}
      {c.rest && restLeft > 0 && !f.timerChangeover && !f.timerSetBreak && (
        <Card style={{ marginTop: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Body weight="semi">{c.rest.kind === "set_break" ? tr("score.setBreak") : c.rest.kind === "tiebreak" ? tr("score.changeEnds") : c.rest.changeEnds ? tr("score.changeoverChangeEnds") : tr("score.changeover")}</Body>
          <Num size={26}>{`${Math.floor(restLeft / 60)}:${String(restLeft % 60).padStart(2, "0")}`}</Num>
          <Body tone="blue" weight="semi" onPress={c.clearRest}>{tr("score.dismiss")}</Body>
        </Card>
      )}

      <CallCard c={call} readOnly={false} />

      <View style={{ flex: 1, marginTop: 10, gap: 10 }}>
        {(boot.chess || resultOnly) && !finished ? (
          boot.chess && !resultAllowed ? (
            <Card style={{ flex: 1, justifyContent: "center", gap: 10 }}>
              <Display size={20}>{tr("score.chessOnWeb")}</Display>
              <Button label={tr("score.openWebConsole")} onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} />
            </Card>
          ) : (
            <Card style={{ flex: 1, padding: 0 }}>
              <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
                {resultEntry(true)}
                {boot.chess ? <Button kind="ghost" label={tr("score.playMovesWeb")} onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} /> : null}
              </ScrollView>
            </Card>
          )
        ) : !shown && !finished ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>{tr("score.whoServesFirst")}</Display>
            {(!A.checkedIn || !B.checkedIn) && !m.tie_id ? <Body tone="live" size={13}>{tr("score.notCheckedIn", { name: !A.checkedIn ? A.name : B.name })}</Body> : null}
            {(["A", "B"] as TeamKey[]).map((k) => (
              <Button key={k} label={side(k).name} disabled={readOnly} onPress={() => guard(() => void c.start(k))} />
            ))}
            {resultAllowed ? <Button kind="ghost" label={tr("score.enterFinalInstead")} disabled={readOnly} onPress={() => guard(() => showResultSheet(false, null))} /> : null}
          </Card>
        ) : awaitingConfirm ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>{tr("score.winsQuestion", { name: shown?.winner ? side(shown.winner).name : "" })}</Display>
            <Body tone="ink2">{tr("score.scoreIsFinal")}</Body>
            <Button label={tr("score.confirmResult")} disabled={readOnly} onPress={() => guard(() => void c.confirmResult())} />
            <Button kind="ghost" label={tr("score.undoLastPoint")} disabled={readOnly} onPress={() => guard(() => void c.undo())} />
          </Card>
        ) : finished ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>{winnerKey ? tr("score.nameWins", { name: side(winnerKey).name }) : tr("score.matchFinished")}</Display>
            <Body tone="ink2">
              {status === "pending_sync" || (pendingN > 0 && !readOnly)
                ? pendingN > 0
                  ? tr("score.savedOnPhoneN", { count: pendingN })
                  : tr("score.savedOnPhone")
                : status === "completed" || (shown?.matchOver && !SERVER_FINISHED.includes(status))
                  ? tr("score.resultIn")
                  : tr("score.ended", { status: ENDED_STATUS.includes(status) ? tr(`score.status_${status}` as "score.status_walkover") : status })}
            </Body>
            {!readOnly && c.canUndo ? <Button kind="ghost" label={tr("score.undoReopen")} onPress={() => guard(() => setSheet({ kind: "reopen" }))} /> : null}
            {correctable ? (
              <Button
                kind="ghost"
                label={tr("score.correctResult")}
                accessibilityHint={tr("score.correctHint")}
                onPress={() => guard(() => showResultSheet(true, !boot.chess && shown?.completedSets.length ? { sets: enteredSetsFromState(shown) } : null))}
              />
            ) : null}
            {/* The log of a finished match: More is gone once the match is over (staff only, as during play). */}
            {f.matchLog ? <Button kind="ghost" label={tr("score.openMatchLog")} onPress={() => void openLog()} /> : null}
            <Button label={tr("score.backToMatches")} onPress={() => router.back()} />
          </Card>
        ) : shown ? (
          <PadV2
            state={shown}
            sides={v2Sides}
            features={f}
            swapped={swapped}
            readOnly={readOnly}
            paused={c.paused}
            blocked={sync.kind === "conflict"}
            canUndo={c.canUndo}
            onPoint={tap}
            onFault={() => v2Tap("fault")}
            onAce={() => v2Tap("ace")}
            onLet={() => guard(() => setSheet({ kind: "let" }))}
            onUndo={() => guard(() => void c.undo())}
            onPause={() => guard(() => void c.pause())}
            onServe={() => guard(() => void c.switchServer())}
            onMore={() => setSheet({ kind: "more" })}
          />
        ) : null}
        {c.timer && c.timer.kind !== "between_points" && !readOnly && shown && !shown.matchOver ? (
          <View style={{ position: "absolute", left: 0, right: 0, top: "18%" }}>
            <TimerCard timer={c.timer} now={tick} sides={v2Sides} onStop={() => void c.endTimer()} onDecision={onDecision} onRetire={() => guard(() => setSheet({ kind: "end", event: "RETIREMENT" }))} />
          </View>
        ) : null}
      </View>

      <Sheetish open={sheet?.kind === "confirm-point"} onClose={() => setSheet(null)} title={tr("score.check")}>
        {sheet?.kind === "confirm-point" && (
          <>
            <Body size={17} weight="semi">{tr("score.aboutToWin", { name: side(sheet.team).name, what: winWhat(sheet.what) })}</Body>
            <Button label={tr("score.yesPoint")} onPress={() => { void c.point(sheet.team); setSheet(null); }} />
            <Button kind="ghost" label={tr("common.cancel")} onPress={() => setSheet(null)} />
          </>
        )}
      </Sheetish>

      <Sheetish open={sheet?.kind === "reopen"} onClose={() => setSheet(null)} title={tr("score.reopenTitle")}>
        <Body size={17} weight="semi">{tr("score.reopenBody")}</Body>
        <Body tone="ink2" size={13}>{tr("score.reopenNote")}</Body>
        <Button kind="danger" label={tr("score.undoAndReopen")} onPress={() => { void c.undo(); setSheet(null); }} />
        <Button kind="ghost" label={tr("score.keepResult")} onPress={() => setSheet(null)} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "more"} onClose={() => setSheet(null)} title={tr("score.more")}>
        {callMaster ? (
          <Button kind="danger" label={tr("score.callMaster")} icon={<Glyph name="megaphone" color="#FFFFFF" size={20} />} onPress={() => setSheet({ kind: "call" })} />
        ) : null}
        {callNote ? <Body tone="ink2" size={12.5}>{callNote}</Body> : null}
        {f.breakStopwatch || f.timerChangeover || f.timerSetBreak || f.bathroom || f.hydration || f.medical || f.warmup ? <Eyebrow size={10} tone="ink3">{tr("score.breaks")}</Eyebrow> : null}
        {(
          [
            ["warmup", f.warmup, timerLabel("warmup"), "5:00"],
            ["break", f.breakStopwatch, timerLabel("break"), tr("score.stopwatch")],
            ["changeover", f.timerChangeover, timerLabel("changeover"), "1:30"],
            ["set_break", f.timerSetBreak, timerLabel("set_break"), "2:00"],
            ["bathroom", f.bathroom, timerLabel("bathroom"), tr("score.warnsAt", { time: "10:00" })],
            ["hydration", f.hydration, timerLabel("hydration"), "10:00"],
            ["medical", f.medical, timerLabel("medical"), "3:00"],
          ] as [TimerKind, boolean, string, string][]
        )
          .filter(([, on]) => on)
          .map(([k, , label, hint]) => (
            <Pressable
              key={k}
              testID={`break-${k}`}
              accessibilityRole="button"
              disabled={readOnly || finished}
              onPress={() => guard(() => (k === "bathroom" || k === "medical" ? setSheet({ kind: "break-team", timer: k }) : (void c.startBreak(k, null), setSheet(null))))}
              style={({ pressed }) => ({ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13, borderRadius: 14, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, opacity: readOnly || finished ? 0.4 : pressed ? 0.7 : 1 })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Glyph name={BREAK_GLYPH[k]} color={t.ink} size={20} />
                <Body weight="bold">{label}</Body>
              </View>
              <Num size={13} tone="ink2">{hint}</Num>
            </Pressable>
          ))}
        {f.manualSwap || f.matchLog ? <Eyebrow size={10} tone="ink3">{tr("score.courtHeading")}</Eyebrow> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          {f.manualSwap ? <Button kind="ghost" label={tr("score.swapSides")} style={{ flex: 1 }} onPress={() => { toggleSwap(); setSheet(null); }} /> : null}
          {f.matchLog ? <Button kind="ghost" label={tr("score.matchLog")} style={{ flex: 1 }} onPress={() => void openLog()} /> : null}
        </View>
        <Eyebrow size={10} tone="ink3">{tr("score.matchHeading")}</Eyebrow>
        {c.opts.doubles || pairs
          ? (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={tr("score.swapServer", { name: v2Sides[k].name })} onPress={() => guard(() => { void c.swapServer(k); setSheet(null); })} />)
          : null}
        {boot.tennis && <Button kind="ghost" label={tr("score.codeViolation")} onPress={() => guard(() => setSheet({ kind: "violation", team: null }))} />}
        {resultAllowed ? <Button kind="ghost" label={tr("score.enterFinal")} onPress={() => guard(() => showResultSheet(false, null))} /> : null}
        <Button kind="ghost" label={tr("score.endSet")} onPress={() => guard(() => setSheet({ kind: "end", event: "SET" }))} />
        <Button kind="ghost" label={tr("score.retirement")} onPress={() => guard(() => setSheet({ kind: "end", event: "RETIREMENT" }))} />
        <Button kind="ghost" label={tr("score.walkover")} onPress={() => guard(() => setSheet({ kind: "end", event: "WALKOVER" }))} />
        <Button kind="ghost" label={tr("score.disqualification")} onPress={() => guard(() => setSheet({ kind: "end", event: "DISQUALIFICATION" }))} />
        <Button kind="ghost" label={tr("score.endMatchNow")} onPress={() => guard(() => setSheet({ kind: "end", event: "FORCE_END" }))} />
        <Button kind="ghost" label={tr("score.handOverTo")} onPress={() => { setHandNote(null); setSheet({ kind: "handover" }); }} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "call"} onClose={() => setSheet(null)} title={tr("score.callMaster")}>
        <Display size={20}>{tr("score.callMasterQuestion", { court: boot.courtName })}</Display>
        <Body tone="ink2">{tr("score.callMasterNote")}</Body>
        <Button
          kind="danger"
          label={tr("score.call")}
          onPress={() => {
            setSheet(null);
            setCallNote(tr("score.calling"));
            void requestAssistance(m.id).then((r) => setCallNote(r.ok ? tr("score.masterCalled") : r.message));
          }}
        />
        <Button kind="ghost" label={tr("common.cancel")} onPress={() => setSheet(null)} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "let"} onClose={() => setSheet(null)} title={tr("score.let")}>
        <Pressable testID="let-serve" accessibilityRole="button" onPress={() => { void c.callLet("serve"); setSheet(null); }} style={{ padding: 16, borderRadius: 18, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, gap: 4 }}>
          <Body weight="bold" size={16}>{tr("score.serveLet")}</Body>
          <Body tone="ink2" size={13}>{shown?.serve ? tr("score.serveLetNote2") : tr("score.serveLetNote")}</Body>
        </Pressable>
        <Pressable testID="let-point" accessibilityRole="button" onPress={() => { void c.callLet("point"); setSheet(null); }} style={{ padding: 16, borderRadius: 18, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, gap: 4 }}>
          <Body weight="bold" size={16}>{tr("score.replayPoint")}</Body>
          <Body tone="ink2" size={13}>{tr("score.replayPointNote")}</Body>
        </Pressable>
        <Button kind="ghost" label={tr("common.cancel")} onPress={() => setSheet(null)} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "confirm-v2"} onClose={() => setSheet(null)} title={tr("score.check")}>
        {sheet?.kind === "confirm-v2" && (
          <>
            <Body size={17} weight="semi">{tr(sheet.action === "ace" ? "score.aceAboutToWin" : "score.dfAboutToWin", { name: side(sheet.team).name, what: winWhat(sheet.what) })}</Body>
            <Button label={tr("common.yes")} onPress={() => { void (sheet.action === "ace" ? c.ace() : c.fault()); setSheet(null); }} />
            <Button kind="ghost" label={tr("common.cancel")} onPress={() => setSheet(null)} />
          </>
        )}
      </Sheetish>

      <Sheetish open={sheet?.kind === "break-team"} onClose={() => setSheet(null)} title={sheet?.kind === "break-team" ? tr("score.whichSide", { what: timerLabel(sheet.timer) }) : ""}>
        {sheet?.kind === "break-team" &&
          (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={v2Sides[k].name} onPress={() => { void c.startBreak(sheet.timer, k); setSheet(null); }} />)}
      </Sheetish>

      <Sheetish open={sheet?.kind === "time-team"} onClose={() => setSheet(null)} title={sheet?.kind === "time-team" ? tr("score.whichSide", { what: tr("score.codeViolationTime") }) : ""}>
        {sheet?.kind === "time-team" &&
          (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={`${v2Sides[k].name} · ${penaltyLabel(c.penaltyFor(k, "time"))}`} onPress={() => { void c.decide(sheet.decision, k); setSheet(null); }} />)}
      </Sheetish>

      <Sheetish tall open={sheet?.kind === "log"} onClose={() => setSheet(null)} title={tr("score.matchLog")}>
        <Body tone="ink2" size={12.5}>{tr("score.logNote")}</Body>
        {log.error ? <Body tone="live">{log.error}</Body> : log.entries ? <MatchLogList entries={log.entries} /> : <Body tone="ink2">{tr("common.loading")}</Body>}
      </Sheetish>

      <Sheetish tall open={askOrder && sheet === null} onClose={() => {}} title={tr("score.startOfSet", { n: c.state?.currentSet ?? 1 })}>
        {askOrder && c.state ? <ServeOrderForm key={c.state.currentSet} sides={v2Sides} teamFree={tossDecidesServer(c.state)} initial={c.state ? lockServeOrder(c.state, defaultServeOrder(c.state)) : defaultServeOrder(c.state)} onConfirm={(o) => guard(() => void c.serveOrder(c.state ? lockServeOrder(c.state, o) : o))} /> : null}
      </Sheetish>

      <Sheetish open={sheet?.kind === "violation"} onClose={() => setSheet(null)} title={tr("score.codeViolation")}>
        {sheet?.kind === "violation" &&
          (sheet.team === null ? (
            (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={side(k).name} onPress={() => setSheet({ kind: "violation", team: k })} />)
          ) : (
            (Object.keys(OFFENCE_LABELS) as (keyof typeof OFFENCE_LABELS)[]).map((o) => (
              <Button
                key={o}
                kind="ghost"
                label={`${offenceLabel(o)} → ${penaltyLabel(c.penaltyFor(sheet.team!, o))}`}
                onPress={() => {
                  void c.violation(sheet.team!, o);
                  setSheet(null);
                }}
              />
            ))
          ))}
      </Sheetish>

      <Sheetish open={sheet?.kind === "end"} onClose={() => setSheet(null)} title={sheet?.kind === "end" ? tr(({ SET: "score.whoWonSet", FORCE_END: "score.whoWonMatch", WALKOVER: "score.whoNoShow", RETIREMENT: "score.whoRetired", DISQUALIFICATION: "score.whoDisqualified" } as const)[sheet.event]) : ""}>
        {sheet?.kind === "end" &&
          (["A", "B"] as TeamKey[]).map((k) => (
            <Button
              key={k}
              kind={sheet.event === "SET" || sheet.event === "FORCE_END" ? "ghost" : "danger"}
              label={side(k).name}
              onPress={() => {
                const other: TeamKey = k === "A" ? "B" : "A";
                if (sheet.event === "SET") void c.endSet(k);
                else if (sheet.event === "RETIREMENT" || sheet.event === "DISQUALIFICATION" || sheet.event === "WALKOVER") void c.endWith(sheet.event, other);
                else void c.endWith(sheet.event, k);
                setSheet(null);
              }}
            />
          ))}
      </Sheetish>

      <Sheetish open={sheet?.kind === "conflict"} onClose={() => setSheet(null)} title={tr("score.notReachingTitle")}>
        <Body weight="semi">{sync.kind === "conflict" ? sync.message : tr("score.serverRefused")}</Body>
        <Body tone="ink2" size={13}>
          {tr("score.conflictWaiting", { count: pendingN })}
        </Body>
        {handNote ? <Body tone="live" size={12.5}>{handNote}</Body> : null}
        <Button label={tr("score.trySendAgain")} onPress={() => { c.syncNow(); setSheet(null); }} />
        <Button kind="danger" label={busy === "load" ? tr("common.loading") : tr("score.loadServerScore")} disabled={busy !== null} onPress={() => void loadServer()} />
        <Body tone="ink3" size={12}>{tr("score.loadingAside")}</Body>
        <Button kind="ghost" label={tr("score.openWebConsole")} onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} />
      </Sheetish>

      <Sheetish open={codeSheet} onClose={closeCode} title={tr("score.refereeCode")}>
        <StaffCodeForm
          note={
            expired || sync.kind === "signed_out"
              ? tr("score.codeRefused")
              : tr("score.codeStay")
          }
          onDone={() => {
            setSheet(null);
            setExpiryAsked(false);
            setSignedOutSeen(false);
            c.syncNow();
          }}
        />
        <Button kind="ghost" label={tr("score.keepScoring")} onPress={closeCode} />
      </Sheetish>

      <Sheetish
        tall
        open={sheet?.kind === "result"}
        onClose={() => {
          if (resultBusy) return;
          setSheet(null);
          setForm(null);
          setResultErr(null);
        }}
        title={form?.correcting ? tr("score.correctResult") : tr("score.finalResult")}
      >
        {sheet?.kind === "result" ? resultEntry(false) : null}
      </Sheetish>

      <Sheetish open={sheet?.kind === "handover"} onClose={() => setSheet(null)} title={tr("score.handOver")}>
        <Body>{tr("score.handOverBody")}</Body>
        {pendingN > 0 ? <Body tone="ink2" size={12.5}>{tr("score.stillToSend", { count: pendingN })}</Body> : null}
        {handNote ? <Body tone="live" size={12.5}>{handNote}</Body> : null}
        <Button label={busy === "release" ? tr("score.sending") : tr("score.sendAndRelease")} disabled={busy !== null} onPress={() => void sendAndRelease()} />
        <Button kind="ghost" label={tr("score.openWebConsole")} onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} />
        <Body tone="ink3" size={12}>{tr("score.releaseNote")}</Body>
        <Button kind="danger" label={tr("score.releaseWithout")} disabled={busy !== null} onPress={() => void (async () => { await c.abandonQueue(); await lease.release(); setSheet(null); })()} />
      </Sheetish>
    </View>
  );
}

const waitingForLineups = (b: RefereeBootstrap | undefined) => Boolean(b && (b.waitingForLineups || !b.sideA || !b.sideB));

/** The icon beside each break in More (drawn, not emoji: emoji can show as "?" boxes). */
const BREAK_GLYPH: Record<string, GlyphName> = { break: "stopwatch", changeover: "clock", set_break: "cup", bathroom: "restroom", hydration: "drop", medical: "medical", warmup: "hourglass" };

export default function ScoreRoute() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const tr = useT();
  const staff = session.use((s) => s.staff);
  const deviceId = session.use((s) => s.installationId) ?? "unknown";
  const [sunlight, setSun] = useState<boolean>(getJson("ms.sunlight", false));
  const setSunlight = (v: boolean) => {
    setSun(v);
    setJson("ms.sunlight", v);
  };
  const boot = useQuery({
    queryKey: ["ref-boot", matchId],
    queryFn: () => api<RefereeBootstrap>(`/api/mobile/v1/referee/matches/${matchId}/bootstrap`, { who: "staff" }),
    enabled: Boolean(staff),
    // Fetched afresh on every visit; the last answer is kept for opening the match offline.
    staleTime: 0,
    gcTime: Infinity,
    retry: 3,
    // Line-ups are entered at the desk: look again until they are in.
    refetchInterval: (q) => (waitingForLineups(q.state.data) ? 10_000 : false),
  });
  const refetch = boot.refetch;
  useFocusEffect(
    useCallback(() => {
      if (staff) void refetch({ cancelRefetch: false });
    }, [staff, refetch]),
  );
  if (!staff) {
    return (
      <SchemeScope scheme={sunlight ? "sunlight" : null}>
        <SignInHere />
      </SchemeScope>
    );
  }
  if (!boot.data) {
    return (
      <SchemeScope scheme={sunlight ? "sunlight" : null}>
        <Opening boot={boot} />
      </SchemeScope>
    );
  }
  if (waitingForLineups(boot.data)) {
    return (
      <SchemeScope scheme={sunlight ? "sunlight" : null}>
        <WaitingForLineups
          matchId={matchId}
          onSaved={() => void refetch()}
          message={tr("score.waitingLineupsMessage", { nation: boot.data.waitingForLineups ?? tr("score.aNation") })}
        />
      </SchemeScope>
    );
  }
  return (
    <SchemeScope scheme={sunlight ? "sunlight" : null}>
      <ConsoleScreen boot={boot.data} deviceId={deviceId} sunlight={sunlight} setSunlight={setSunlight} />
    </SchemeScope>
  );
}

/** Signed out (or the code lapsed while the app was closed): sign in right here, the match's points stay queued. */
function SignInHere() {
  const { t } = useTheme();
  const tr = useT();
  return (
    <View style={{ flex: 1, backgroundColor: t.floor, justifyContent: "center", gap: 12, padding: 24 }}>
      <Display size={22}>{tr("score.codeNeeded")}</Display>
      <StaffCodeForm note={tr("score.codeNeededNote")} />
      <Button kind="ghost" label={tr("common.back")} onPress={() => router.back()} />
    </View>
  );
}

/** The match is not on this phone yet: opening, no signal, or refused. Points already queued are untouched. */
function Opening({ boot }: { boot: LoadQuery }) {
  const { t } = useTheme();
  const tr = useT();
  return (
    <View style={{ flex: 1, backgroundColor: t.floor, justifyContent: "center", gap: 12, padding: 24 }}>
      <LoadState queries={[boot]} what={tr("score.theMatch")} errorNote={boot.error instanceof ApiError && boot.error.status >= 400 && boot.error.status < 500 ? tr("score.safeAfter", { message: boot.error.message }) : tr("score.safeNote")} />
      <Button kind="ghost" label={tr("common.back")} onPress={() => router.back()} />
    </View>
  );
}

/** No players for this rubber yet: the court referee (or a master referee) enters them right here. */
function WaitingForLineups({ matchId, message, onSaved }: { matchId: string; message: string; onSaved: () => void }) {
  const { t } = useTheme();
  const tr = useT();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.floor }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, gap: 12 }} keyboardShouldPersistTaps="handled">
      <BackHeader label={tr("score.matches")} />
      <LineupScreenBody matchId={matchId} onSaved={onSaved} fallback={message} />
    </ScrollView>
  );
}

function Waiting({ error, message }: { error: boolean; message?: string }) {
  const { t } = useTheme();
  const tr = useT();
  return (
    <View style={{ flex: 1, backgroundColor: t.floor, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
      <Display size={22}>{message ? tr("score.waitingLineups") : error ? tr("score.couldNotOpen") : tr("score.opening")}</Display>
      <Body tone="ink2" style={{ textAlign: "center" }}>{message ?? (error ? tr("score.checkSignalSafe") : "")}</Body>
      <Button kind="ghost" label={tr("common.back")} onPress={() => router.back()} />
    </View>
  );
}
