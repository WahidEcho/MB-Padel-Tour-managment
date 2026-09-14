"use client";

import { DELAY_OPTIONS, LEAD_IN_OPTIONS, type useUmpireVoice, type VoiceStatus } from "./useUmpireVoice";

const STATUS_TEXT: Record<VoiceStatus, string> = {
  off: "Off on this phone.",
  loading: "Downloading the voice (about 5 MB, once)…",
  ready: "Ready. The score is called after each point.",
  missing: "The voice pack is not installed on this server yet.",
  error: "Could not download the voice. Check the connection and try Test again.",
  blocked: "This phone blocked the sound. Tap Test once to allow it.",
};

/** The referee's voice umpire controls, shown in the scoring page's dialog. */
export default function VoicePanel({
  voice,
  onClose,
}: {
  voice: ReturnType<typeof useUmpireVoice>;
  onClose: () => void;
}) {
  const { settings, setSettings, status, caption, test } = voice;
  const on = settings.enabled;

  return (
    <div className="space-y-3" data-testid="voice-panel">
      <div>
        <h3 className="font-bold">Voice umpire</h3>
        <p className="text-sm text-muted">
          Calls the score out loud after each point, server&apos;s score first. Connect this phone to a speaker and
          keep this page open.
        </p>
      </div>

      <button
        type="button"
        className={`w-full justify-center ${on ? "btn-secondary" : "btn-primary"}`}
        onClick={() => setSettings({ enabled: !on })}
        data-testid="voice-toggle"
      >
        {on ? "Turn voice off" : "Turn voice on"}
      </button>

      <p className={`text-xs ${status === "ready" || status === "off" ? "text-muted" : "text-warning"}`} data-testid="voice-status">
        {STATUS_TEXT[status]}
      </p>

      {on && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              <span className="label">Call after</span>
              <select
                className="input"
                value={settings.delayMs}
                onChange={(e) => setSettings({ delayMs: Number(e.target.value) })}
                data-testid="voice-delay"
              >
                {DELAY_OPTIONS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms / 1000} s
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="label">Speaker wake-up</span>
              <select
                className="input"
                value={settings.leadInMs}
                onChange={(e) => setSettings({ leadInMs: Number(e.target.value) })}
                data-testid="voice-lead-in"
              >
                {LEAD_IN_OPTIONS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms === 0 ? "None" : `${ms} ms`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted">
            If a Bluetooth speaker cuts off the first word, raise the wake-up time and press Test.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.muted}
              onChange={(e) => setSettings({ muted: e.target.checked })}
              className="h-4 w-4"
              data-testid="voice-mute-toggle"
            />
            Mute the calls for now (the voice stays on)
          </label>
          <button type="button" className="btn-secondary w-full justify-center" onClick={test} data-testid="voice-test">
            ▶ Test
          </button>
          {caption && (
            <p className="rounded-lg bg-background px-3 py-2 text-sm" data-testid="voice-caption">
              🔊 {caption}
            </p>
          )}
          <p className="text-[11px] text-muted">The voice is AI-generated. It keeps the screen on while it is enabled.</p>
        </>
      )}

      <button type="button" className="btn-secondary w-full" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
