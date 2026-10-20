import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, TextInput, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useKeepAwake } from "expo-keep-awake";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Console,
  chessCompetitionFor,
  describeMatchRules,
  enteredSetsFromState,
  finalResultAllowed,
  queueableResult,
  OFFENCE_LABELS,
  PENALTY_LABELS,
  currentServer,
  servingPlayer,
  receivingPlayer,
  aceMoment,
  defaultServeOrder,
  lockServeOrder,
  tossDecidesServer,
  needsServeOrder,
  nationByCode,
  sidesSwapped,
  TIMERS,
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

function SyncPill({ s, online }: { s: SyncState; online: boolean }) {
  const { t } = useTheme();
  const n = "pending" in s ? s.pending : 0;
  const [label, color] =
    s.kind === "conflict"
      ? [s.reason === "device_lock" ? "Another phone has control" : "Sync problem", t.live]
      : s.kind === "signed_out"
        ? ["Sign in again to send", t.live]
        : !online || s.kind === "offline"
          ? [`Offline · ${n} on this phone`, t.warning]
          : s.kind === "syncing"
            ? [`Sending ${n}…`, t.blue]
            : n > 0
              ? [`${n} waiting to send`, t.warning]
              : ["Online · all saved", t.success];
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
    setErr(r.pinRequired && !needPin ? `${r.court ?? "This code"}: pick your name and enter your 4-digit referee PIN.` : r.message);
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
        placeholder="Code from the tournament desk"
        placeholderTextColor={t.ink3}
        accessibilityLabel="Referee access code"
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
          placeholder="Your 4-digit PIN"
          placeholderTextColor={t.ink3}
          accessibilityLabel="Referee PIN"
          onSubmitEditing={() => void submit()}
          style={{ ...input, letterSpacing: 8, textAlign: "center" }}
        />
      )}
      {err ? <Body tone="live" size={13}>{err}</Body> : null}
      <Button label={busy ? "Checking…" : "Sign in again"} disabled={!code || busy || (needPin && (pin.length !== 4 || (referees.length > 0 && !refereeId)))} onPress={() => void submit()} />
    </View>
  );
}

function pointText(s: ScoreState | null, k: TeamKey) {
  if (!s) return "0";
  if (s.isTiebreak) return String(k === "A" ? s.teamA.tiebreakPoints : s.teamB.tiebreakPoints);
  return k === "A" ? s.teamA.points : s.teamB.points;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function ConsoleScreen({ boot, deviceId, sunlight, setSunlight }: { boot: RefereeBootstrap; deviceId: string; sunlight: boolean; setSunlight: (v: boolean) => void }) {
  useKeepAwake();
  const { t } = useTheme();
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
      setLog({ entries: null, error: e instanceof ApiError && e.status !== 0 ? e.message : "No signal: the log needs a connection." });
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
    else setHandNote("Points on this phone have not reached the server yet. Hand over once they are sent, or the next device starts without them.");
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
      setHandNote("Not every point reached the server, so control was kept. Check the signal and try again.");
    }
    setBusy(null);
  };

  const loadServer = async () => {
    setBusy("load");
    const ok = c.blocked && !c.question ? await c.reload() : await c.loadServerScore();
    setBusy(null);
    if (ok) setSheet(null);
    else setHandNote("No signal: the server's score could not be loaded. Try again.");
  };

  /**
   * A final result: games results are checked and queued like a point (offline
   * too); a correction of a finished match and chess results go straight to the
   * server (they need a connection).
   */
  const submitResult = async (payload: ResultPayload) => {
    if (busy || resultBusy) return;
    if (sync.kind === "conflict") {
      setResultErr({ message: "Points are not reaching the server: sort that out first (What now?).", problems: [] });
      return;
    }
    setResultBusy(true);
    try {
      let out: { ok: true } | { ok: false; message: string; problems: ResultProblem[] };
      if (boot.chess) {
        const e = chessEntry(payload, { mode, competition: chessCompetitionFor(m.stage), legs: boot.legs ?? 1, organiser });
        out = e.ok ? await c.sendResultNow(e) : { ok: false, message: e.problems[0]?.message ?? "Check the result.", problems: e.problems };
      } else if (finished) {
        const q = queueableResult({ mode, engine: "games", rules: boot.config, payload });
        out = q.ok ? await c.sendResultNow({ payload: q.payload, state: q.state, winner: q.winner }) : { ok: false, message: q.problems[0]?.message ?? "Check the score.", problems: q.problems };
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
          ? "Read-only: take control of the match to record a result."
          : boot.chess || form?.correcting
            ? "Sent straight to the server: it needs a connection."
            : "Saved on this phone first: it reaches the server as soon as there is signal."
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
            const rcv = shown && pairs && !shown.matchOver ? receivingPlayer(shown) : null;
            const srv = shown && pairs && !shown.matchOver ? servingPlayer(shown) : null;
            const who =
              srv?.team === k ? `Serving: ${s.players[srv.index]?.name ?? ""}` : rcv?.team === k ? `Receiving: ${s.players[rcv.index]?.name ?? ""}` : c.opts.doubles && servingIdx?.team === k ? `Serving: ${s.players[servingIdx.index]?.name ?? ""}` : s.players.map((p) => p.name).join(" / ");
            const aces = f.ace && shown?.stats ? shown.stats.aces[k] : 0;
            return <Eyebrow size={10} tone="ink2" numberOfLines={1}>{`${who}${aces ? ` · ${aces} ace${aces === 1 ? "" : "s"}` : ""}`}</Eyebrow>;
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
              <Chip label="Line-up" />
            </Pressable>
          ) : null}
          <Pressable onPress={() => setSunlight(!sunlight)} accessibilityRole="switch" accessibilityState={{ checked: sunlight }} hitSlop={8}>
            <Chip label={sunlight ? "Sunlight on" : "Sunlight"} ball={sunlight} icon={<Glyph name="sun" color={sunlight ? t.ballInk : t.ink2} size={13} />} />
          </Pressable>
        </View>
        {scoreRow("A")}
        {scoreRow("B")}
        <Body tone="ink3" size={11}>{describeMatchRules(boot.config)}</Body>
        {f.ace && aceMoment(shown) ? (
          <View testID="ace-moment" style={{ position: "absolute", left: 16, top: -11, backgroundColor: BALL, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
            <Eyebrow size={11} style={{ color: BALL_INK }}>Ace</Eyebrow>
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
              ? "Your referee code has expired. Points are kept on this phone but cannot be sent."
              : `Your referee code expires at ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${expiresAt - clock > 12 * 60 * 60 * 1000 ? " tomorrow" : ""}. Re-enter it at a break.`}
          </Body>
          <Button kind="ghost" label="Re-enter the code" onPress={() => setSheet({ kind: "code" })} />
        </Card>
      )}

      {/* Control: who is scoring this match. A finished match has nothing to hand over (as on the web). */}
      {readOnly && lease.ready && !finished && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.warning, borderWidth: 1 }}>
          <Body weight="semi">{lease.lostTo ? `Control moved to ${lease.lostTo}` : lease.heldByOther ? `Read-only: ${lease.holderLabel} is scoring` : "Not scoring yet"}</Body>
          {lease.lostTo ? (
            <Body tone="ink2" size={12.5}>
              {pendingN > 0
                ? `This phone is read-only now. Unsent points on it: ${pendingN}. They are kept; ask for control to send them.`
                : "This phone is read-only now. Ask for control to score again."}
            </Body>
          ) : null}
          {lease.heldByOther ? (
            <Button label={lease.myRequestPending ? "Waiting for a reply… ask again" : "Request control"} kind="ghost" onPress={() => void lease.requestControl()} />
          ) : (
            <Button label="Take control" onPress={() => void lease.claim()} />
          )}
        </Card>
      )}
      {lease.incomingRequest && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.ball, borderWidth: 2 }}>
          <Body weight="semi">{`${lease.incomingRequest.deviceLabel ?? "Another phone"} wants to score this match`}</Body>
          {pendingN > 0 ? <Body tone="live" size={12.5}>{`${plural(pendingN, "point")} on this phone must reach the server before you hand over.`}</Body> : null}
          {handNote && sheet === null ? <Body tone="live" size={12.5}>{handNote}</Body> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="ghost" label="Decline" onPress={() => void lease.respond(false)} style={{ flex: 1 }} />
            {pendingN > 0 && busy !== "handover" ? (
              <Button kind="ghost" label="Send now" onPress={() => c.syncNow()} style={{ flex: 1 }} />
            ) : (
              <Button label={busy === "handover" ? "Sending…" : "Hand over"} disabled={busy !== null || pendingN > 0} onPress={() => void handOver()} style={{ flex: 1 }} />
            )}
          </View>
        </Card>
      )}
      {c.question && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.live, borderWidth: 1 }}>
          <Body weight="semi">{`This phone has ${plural(c.question.pending, "unsent point")}, but the server's score has moved on.`}</Body>
          <Body tone="ink2" size={12.5}>
            {`Its points start at event ${c.question.first}; the server is at event ${c.question.serverNo}. Sent as they are, the server would refuse them.`}
          </Body>
          <Button kind="ghost" label="Keep this phone's score" onPress={() => void c.keepLocal()} />
          <Button kind="danger" label={busy === "load" ? "Loading…" : "Use the server's score"} disabled={busy !== null} onPress={() => void loadServer()} />
          <Body tone="ink3" size={12}>The server's score sets this phone's unsent points aside; they are kept on the phone, never sent.</Body>
        </Card>
      )}
      {c.blocked && !c.question && (
        <Card style={{ marginTop: 10, gap: 8, borderColor: t.warning, borderWidth: 1 }}>
          <Body weight="semi">{c.blocked}</Body>
          <Button kind="ghost" label={busy === "load" ? "Loading…" : "Load the server score"} disabled={busy !== null} onPress={() => void loadServer()} />
        </Card>
      )}
      {c.writeError && !c.question && (
        <Card style={{ marginTop: 10, gap: 6, borderColor: t.live, borderWidth: 1 }}>
          <Body weight="semi" tone="live">{c.writeError}</Body>
          <Body tone="blue" weight="semi" onPress={c.clearWriteError}>Dismiss</Body>
        </Card>
      )}
      {sync.kind === "conflict" && (
        <Card style={{ marginTop: 10, gap: 6, borderColor: t.live, borderWidth: 1 }}>
          <Body weight="semi">{sync.message}</Body>
          <Body tone="ink2" size={12.5}>Scoring is paused on this phone: points scored now would not reach the server either.</Body>
          <Button kind="ghost" label="What now?" onPress={() => setSheet({ kind: "conflict" })} />
        </Card>
      )}
      {c.rest && restLeft > 0 && !f.timerChangeover && !f.timerSetBreak && (
        <Card style={{ marginTop: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Body weight="semi">{c.rest.kind === "set_break" ? "Set break" : c.rest.kind === "tiebreak" ? "Change ends" : c.rest.changeEnds ? "Changeover · change ends" : "Changeover"}</Body>
          <Num size={26}>{`${Math.floor(restLeft / 60)}:${String(restLeft % 60).padStart(2, "0")}`}</Num>
          <Body tone="blue" weight="semi" onPress={c.clearRest}>Dismiss</Body>
        </Card>
      )}

      <CallCard c={call} readOnly={false} />

      <View style={{ flex: 1, marginTop: 10, gap: 10 }}>
        {(boot.chess || resultOnly) && !finished ? (
          boot.chess && !resultAllowed ? (
            <Card style={{ flex: 1, justifyContent: "center", gap: 10 }}>
              <Display size={20}>Chess is scored on the web</Display>
              <Button label="Open the web console" onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} />
            </Card>
          ) : (
            <Card style={{ flex: 1, padding: 0 }}>
              <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
                {resultEntry(true)}
                {boot.chess ? <Button kind="ghost" label="Play the moves on the web console" onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} /> : null}
              </ScrollView>
            </Card>
          )
        ) : !shown && !finished ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>Who serves first?</Display>
            {(!A.checkedIn || !B.checkedIn) && !m.tie_id ? <Body tone="live" size={13}>{`${!A.checkedIn ? A.name : B.name} is not checked in yet.`}</Body> : null}
            {(["A", "B"] as TeamKey[]).map((k) => (
              <Button key={k} label={side(k).name} disabled={readOnly} onPress={() => guard(() => void c.start(k))} />
            ))}
            {resultAllowed ? <Button kind="ghost" label="Enter the final result instead" disabled={readOnly} onPress={() => guard(() => showResultSheet(false, null))} /> : null}
          </Card>
        ) : awaitingConfirm ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>{`${shown?.winner ? side(shown.winner).name : ""} wins?`}</Display>
            <Body tone="ink2">The score is final. Confirm the result to send it to the standings and screens, or undo the last point.</Body>
            <Button label="Confirm result" disabled={readOnly} onPress={() => guard(() => void c.confirmResult())} />
            <Button kind="ghost" label="Undo last point" disabled={readOnly} onPress={() => guard(() => void c.undo())} />
          </Card>
        ) : finished ? (
          <Card style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Display size={22}>{winnerKey ? `${side(winnerKey).name} wins` : "Match finished"}</Display>
            <Body tone="ink2">
              {status === "pending_sync" || (pendingN > 0 && !readOnly)
                ? `The result is saved on this phone. It becomes official once it reaches the server${pendingN > 0 ? ` (${pendingN} to send)` : ""}.`
                : status === "completed" || (shown?.matchOver && !SERVER_FINISHED.includes(status))
                  ? "The result is in."
                  : `Ended: ${status}.`}
            </Body>
            {!readOnly && c.canUndo ? <Button kind="ghost" label="Undo (reopen the match)" onPress={() => guard(() => setSheet({ kind: "reopen" }))} /> : null}
            {correctable ? (
              <Button
                kind="ghost"
                label="Correct the result"
                accessibilityHint="Replaces the recorded score. Needs a connection."
                onPress={() => guard(() => showResultSheet(true, !boot.chess && shown?.completedSets.length ? { sets: enteredSetsFromState(shown) } : null))}
              />
            ) : null}
            <Button label="Back to matches" onPress={() => router.back()} />
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
            <TimerCard timer={c.timer} now={tick} sides={v2Sides} onStop={() => void c.endTimer()} onDecision={onDecision} />
          </View>
        ) : null}
      </View>

      <Sheetish open={sheet?.kind === "confirm-point"} onClose={() => setSheet(null)} title="Check">
        {sheet?.kind === "confirm-point" && (
          <>
            <Body size={17} weight="semi">{`${side(sheet.team).name} is about to win ${sheet.what}.`}</Body>
            <Button label="Yes, point" onPress={() => { void c.point(sheet.team); setSheet(null); }} />
            <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
          </>
        )}
      </Sheetish>

      <Sheetish open={sheet?.kind === "reopen"} onClose={() => setSheet(null)} title="Reopen the match?">
        <Body size={17} weight="semi">Undo takes the result back and puts the match live again.</Body>
        <Body tone="ink2" size={13}>The standings, the draw and the venue screens lose this result until the match is finished again.</Body>
        <Button kind="danger" label="Undo and reopen" onPress={() => { void c.undo(); setSheet(null); }} />
        <Button kind="ghost" label="Keep the result" onPress={() => setSheet(null)} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "more"} onClose={() => setSheet(null)} title="More">
        {callMaster ? (
          <Button kind="danger" label="Call master referee" icon={<Glyph name="megaphone" color="#FFFFFF" size={20} />} onPress={() => setSheet({ kind: "call" })} />
        ) : null}
        {callNote ? <Body tone="ink2" size={12.5}>{callNote}</Body> : null}
        {f.breakStopwatch || f.timerChangeover || f.timerSetBreak || f.bathroom || f.hydration ? <Eyebrow size={10} tone="ink3">Breaks</Eyebrow> : null}
        {(
          [
            ["break", f.breakStopwatch, "Break", "Stopwatch"],
            ["changeover", f.timerChangeover, "Changeover", "1:30"],
            ["set_break", f.timerSetBreak, "Set break", "2:00"],
            ["bathroom", f.bathroom, "Bathroom break", "warns 10:00"],
            ["hydration", f.hydration, "Hydration break", "10:00"],
          ] as [TimerKind, boolean, string, string][]
        )
          .filter(([, on]) => on)
          .map(([k, , label, hint]) => (
            <Pressable
              key={k}
              testID={`break-${k}`}
              accessibilityRole="button"
              disabled={readOnly || finished}
              onPress={() => guard(() => (k === "bathroom" ? setSheet({ kind: "break-team", timer: k }) : (void c.startBreak(k, null), setSheet(null))))}
              style={({ pressed }) => ({ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13, borderRadius: 14, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, opacity: readOnly || finished ? 0.4 : pressed ? 0.7 : 1 })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Glyph name={BREAK_GLYPH[k]} color={t.ink} size={20} />
                <Body weight="bold">{label}</Body>
              </View>
              <Num size={13} tone="ink2">{hint}</Num>
            </Pressable>
          ))}
        {f.manualSwap || f.matchLog ? <Eyebrow size={10} tone="ink3">Court</Eyebrow> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          {f.manualSwap ? <Button kind="ghost" label="Swap left / right" style={{ flex: 1 }} onPress={() => { toggleSwap(); setSheet(null); }} /> : null}
          {f.matchLog ? <Button kind="ghost" label="Match log" style={{ flex: 1 }} onPress={() => void openLog()} /> : null}
        </View>
        <Eyebrow size={10} tone="ink3">Match</Eyebrow>
        {c.opts.doubles || pairs
          ? (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={`Swap ${v2Sides[k].name}'s server`} onPress={() => guard(() => { void c.swapServer(k); setSheet(null); })} />)
          : null}
        {boot.tennis && <Button kind="ghost" label="Code violation" onPress={() => guard(() => setSheet({ kind: "violation", team: null }))} />}
        {resultAllowed ? <Button kind="ghost" label="Enter the final result" onPress={() => guard(() => showResultSheet(false, null))} /> : null}
        <Button kind="ghost" label="End the set" onPress={() => guard(() => setSheet({ kind: "end", event: "SET" }))} />
        <Button kind="ghost" label="Retirement" onPress={() => guard(() => setSheet({ kind: "end", event: "RETIREMENT" }))} />
        <Button kind="ghost" label="Walkover" onPress={() => guard(() => setSheet({ kind: "end", event: "WALKOVER" }))} />
        <Button kind="ghost" label="Disqualification" onPress={() => guard(() => setSheet({ kind: "end", event: "DISQUALIFICATION" }))} />
        <Button kind="ghost" label="End the match now" onPress={() => guard(() => setSheet({ kind: "end", event: "FORCE_END" }))} />
        <Button kind="ghost" label="Hand over to another phone or the web" onPress={() => { setHandNote(null); setSheet({ kind: "handover" }); }} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "call"} onClose={() => setSheet(null)} title="Call master referee">
        <Display size={20}>{`Call the master referee to ${boot.courtName}?`}</Display>
        <Body tone="ink2">Every master referee on duty gets an alert.</Body>
        <Button
          kind="danger"
          label="Call"
          onPress={() => {
            setSheet(null);
            setCallNote("Calling…");
            void requestAssistance(m.id).then((r) => setCallNote(r.ok ? "Master referee called: their answer shows under the score." : r.message));
          }}
        />
        <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "let"} onClose={() => setSheet(null)} title="Let">
        <Pressable testID="let-serve" accessibilityRole="button" onPress={() => { void c.callLet("serve"); setSheet(null); }} style={{ padding: 16, borderRadius: 18, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, gap: 4 }}>
          <Body weight="bold" size={16}>⊕  Serve let — replay this serve</Body>
          <Body tone="ink2" size={13}>{`Serve touched the net and landed in. Same serve again${shown?.serve ? ": still the 2nd serve." : "."}`}</Body>
        </Pressable>
        <Pressable testID="let-point" accessibilityRole="button" onPress={() => { void c.callLet("point"); setSheet(null); }} style={{ padding: 16, borderRadius: 18, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, gap: 4 }}>
          <Body weight="bold" size={16}>↶  Replay point — interference</Body>
          <Body tone="ink2" size={13}>Something interfered with play. The whole point is replayed from the 1st serve.</Body>
        </Pressable>
        <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
      </Sheetish>

      <Sheetish open={sheet?.kind === "confirm-v2"} onClose={() => setSheet(null)} title="Check">
        {sheet?.kind === "confirm-v2" && (
          <>
            <Body size={17} weight="semi">{`${sheet.action === "ace" ? "Ace" : "Double fault"}: ${side(sheet.team).name} is about to win ${sheet.what}.`}</Body>
            <Button label="Yes" onPress={() => { void (sheet.action === "ace" ? c.ace() : c.fault()); setSheet(null); }} />
            <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
          </>
        )}
      </Sheetish>

      <Sheetish open={sheet?.kind === "break-team"} onClose={() => setSheet(null)} title={sheet?.kind === "break-team" ? `${TIMERS[sheet.timer].label}: which side?` : ""}>
        {sheet?.kind === "break-team" &&
          (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={v2Sides[k].name} onPress={() => { void c.startBreak(sheet.timer, k); setSheet(null); }} />)}
      </Sheetish>

      <Sheetish open={sheet?.kind === "time-team"} onClose={() => setSheet(null)} title={sheet?.kind === "time-team" ? `${sheet.decision === "code_violation" ? "Code violation (time)" : "Warning"}: which side?` : ""}>
        {sheet?.kind === "time-team" &&
          (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={v2Sides[k].name} onPress={() => { void c.decide(sheet.decision, k); setSheet(null); }} />)}
      </Sheetish>

      <Sheetish tall open={sheet?.kind === "log"} onClose={() => setSheet(null)} title="Match log">
        <Body tone="ink2" size={12.5}>Newest first · every point, call, violation and break</Body>
        {log.error ? <Body tone="live">{log.error}</Body> : log.entries ? <MatchLogList entries={log.entries} /> : <Body tone="ink2">Loading…</Body>}
      </Sheetish>

      <Sheetish tall open={askOrder && sheet === null} onClose={() => {}} title={`Start of set ${c.state?.currentSet ?? 1}`}>
        {askOrder && c.state ? <ServeOrderForm key={c.state.currentSet} sides={v2Sides} teamFree={tossDecidesServer(c.state)} initial={c.state ? lockServeOrder(c.state, defaultServeOrder(c.state)) : defaultServeOrder(c.state)} onConfirm={(o) => guard(() => void c.serveOrder(c.state ? lockServeOrder(c.state, o) : o))} /> : null}
      </Sheetish>

      <Sheetish open={sheet?.kind === "violation"} onClose={() => setSheet(null)} title="Code violation">
        {sheet?.kind === "violation" &&
          (sheet.team === null ? (
            (["A", "B"] as TeamKey[]).map((k) => <Button key={k} kind="ghost" label={side(k).name} onPress={() => setSheet({ kind: "violation", team: k })} />)
          ) : (
            (Object.keys(OFFENCE_LABELS) as (keyof typeof OFFENCE_LABELS)[]).map((o) => (
              <Button
                key={o}
                kind="ghost"
                label={`${OFFENCE_LABELS[o]} → ${PENALTY_LABELS[c.penaltyFor(sheet.team!, o)]}`}
                onPress={() => {
                  void c.violation(sheet.team!, o);
                  setSheet(null);
                }}
              />
            ))
          ))}
      </Sheetish>

      <Sheetish open={sheet?.kind === "end"} onClose={() => setSheet(null)} title={sheet?.kind === "end" ? ({ SET: "Who won the set?", FORCE_END: "Who won the match?", WALKOVER: "Who did not turn up?", RETIREMENT: "Who retired?", DISQUALIFICATION: "Who is disqualified?" } as const)[sheet.event] : ""}>
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

      <Sheetish open={sheet?.kind === "conflict"} onClose={() => setSheet(null)} title="Points are not reaching the server">
        <Body weight="semi">{sync.kind === "conflict" ? sync.message : "The server refused this phone's points."}</Body>
        <Body tone="ink2" size={13}>
          {`${plural(pendingN, "point")} on this phone ${pendingN === 1 ? "is" : "are"} waiting. Points scored now would be refused too, so scoring is paused here.`}
        </Body>
        {handNote ? <Body tone="live" size={12.5}>{handNote}</Body> : null}
        <Button label="Try sending again" onPress={() => { c.syncNow(); setSheet(null); }} />
        <Button kind="danger" label={busy === "load" ? "Loading…" : "Load the server score"} disabled={busy !== null} onPress={() => void loadServer()} />
        <Body tone="ink3" size={12}>Loading the server score sets this phone's unsent points aside (kept on the phone, never sent); re-enter any that are missing.</Body>
        <Button kind="ghost" label="Open the web console" onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} />
      </Sheetish>

      <Sheetish open={codeSheet} onClose={closeCode} title="Referee code">
        <StaffCodeForm
          note={
            expired || sync.kind === "signed_out"
              ? "The server no longer accepts this phone's referee code. Scoring carries on: points stay on this phone and send once the code is entered again."
              : "Enter the code from the tournament desk to stay signed in. Points on this phone are kept."
          }
          onDone={() => {
            setSheet(null);
            setExpiryAsked(false);
            setSignedOutSeen(false);
            c.syncNow();
          }}
        />
        <Button kind="ghost" label="Keep scoring on this phone" onPress={closeCode} />
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
        title={form?.correcting ? "Correct the result" : "Final result"}
      >
        {sheet?.kind === "result" ? resultEntry(false) : null}
      </Sheetish>

      <Sheetish open={sheet?.kind === "handover"} onClose={() => setSheet(null)} title="Hand over">
        <Body>Send every point first, then release control. The next phone, or the web console, takes over from the server's score.</Body>
        {pendingN > 0 ? <Body tone="ink2" size={12.5}>{`${plural(pendingN, "point")} still to send.`}</Body> : null}
        {handNote ? <Body tone="live" size={12.5}>{handNote}</Body> : null}
        <Button label={busy === "release" ? "Sending…" : "Send and release"} disabled={busy !== null} onPress={() => void sendAndRelease()} />
        <Button kind="ghost" label="Open the web console" onPress={() => void Linking.openURL(`${config.apiBaseUrl}/referee/matches/${m.id}/score`)} />
        <Body tone="ink3" size={12}>If this phone cannot send its points, release anyway: the points on it are kept, never sent, and must be re-entered on the new device.</Body>
        <Button kind="danger" label="Release without sending" disabled={busy !== null} onPress={() => void (async () => { await c.abandonQueue(); await lease.release(); setSheet(null); })()} />
      </Sheetish>
    </View>
  );
}

const waitingForLineups = (b: RefereeBootstrap | undefined) => Boolean(b && (b.waitingForLineups || !b.sideA || !b.sideB));

/** The icon beside each break in More (drawn, not emoji: emoji can show as "?" boxes). */
const BREAK_GLYPH: Record<string, GlyphName> = { break: "stopwatch", changeover: "clock", set_break: "cup", bathroom: "restroom", hydration: "drop" };

export default function ScoreRoute() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
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
          message={`${boot.data.waitingForLineups ?? "A nation"}'s captain has not nominated the players for this rubber yet. The court referee, a master referee or the tournament desk enters them. This page checks again every 10 seconds.`}
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
  return (
    <View style={{ flex: 1, backgroundColor: t.floor, justifyContent: "center", gap: 12, padding: 24 }}>
      <Display size={22}>Referee code needed</Display>
      <StaffCodeForm note="Points already on this phone are kept, and send once you are signed in." />
      <Button kind="ghost" label="Back" onPress={() => router.back()} />
    </View>
  );
}

/** The match is not on this phone yet: opening, no signal, or refused. Points already queued are untouched. */
function Opening({ boot }: { boot: LoadQuery }) {
  const { t } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.floor, justifyContent: "center", gap: 12, padding: 24 }}>
      <LoadState queries={[boot]} what="the match" errorNote={boot.error instanceof ApiError && boot.error.status >= 400 && boot.error.status < 500 ? `${boot.error.message} Points already on this phone are safe.` : "Points already on this phone are safe. Try again in a moment."} />
      <Button kind="ghost" label="Back" onPress={() => router.back()} />
    </View>
  );
}

/** No players for this rubber yet: the court referee (or a master referee) enters them right here. */
function WaitingForLineups({ matchId, message, onSaved }: { matchId: string; message: string; onSaved: () => void }) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.floor }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, gap: 12 }} keyboardShouldPersistTaps="handled">
      <BackHeader label="Matches" />
      <LineupScreenBody matchId={matchId} onSaved={onSaved} fallback={message} />
    </ScrollView>
  );
}

function Waiting({ error, message }: { error: boolean; message?: string }) {
  const { t } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.floor, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
      <Display size={22}>{message ? "Waiting for the line-ups" : error ? "Could not open the match" : "Opening the match…"}</Display>
      <Body tone="ink2" style={{ textAlign: "center" }}>{message ?? (error ? "Check the signal. Points already on this phone are safe." : "")}</Body>
      <Button kind="ghost" label="Back" onPress={() => router.back()} />
    </View>
  );
}
