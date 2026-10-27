import type { Metadata } from "next";
import { ANDROID_APK, PLAY_STORE_URL } from "../stores";
import { AndroidButton, BRAND, Shell, display } from "../ui";

/** tour.mbeg.org/app/android: Google Play first; the APK and how to install it stay for phones without Play. */
export const metadata: Metadata = {
  title: { absolute: "Move Score for Android · Move Beyond" },
  description: "Download Move Score for Android and install it in five steps.",
};

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Download",
    body: (
      <>
        Tap <strong>Download Move Score</strong> above (Chrome is best). If Chrome warns that the file may be harmful, tap{" "}
        <strong>Download anyway</strong>. Use Wi-Fi if you can: it is about {ANDROID_APK.sizeMb} MB.
      </>
    ),
  },
  {
    title: "Open the file",
    body: (
      <>
        When the download finishes, tap <strong>Open</strong> in the bar at the bottom, or find <strong>Move Score</strong> in your{" "}
        <strong>Downloads</strong> (Files app → Downloads).
      </>
    ),
  },
  {
    title: "Allow this install",
    body: (
      <>
        The first time, Android blocks apps from outside Google Play. Tap <strong>Settings</strong> on the message, turn on{" "}
        <strong>Allow from this source</strong>, then press back. This allows Chrome (or your Files app) only, not every app.
      </>
    ),
  },
  {
    title: "Install",
    body: (
      <>
        Tap <strong>Install</strong>. If Google Play Protect says the app is unrecognised, tap <strong>More details</strong> →{" "}
        <strong>Install anyway</strong>. Move Score is signed by {BRAND.name}.
      </>
    ),
  },
  {
    title: "Open and allow alerts",
    body: (
      <>
        Open Move Score and tap <strong>Allow</strong> for notifications, so you hear when a match is called, starts and finishes.
      </>
    ),
  },
];

const PHONE_NOTES: [string, React.ReactNode][] = [
  [
    "Didn't see “Allow from this source”?",
    <>
      Go to <strong>Settings → Apps → Special app access → Install unknown apps</strong>, choose <strong>Chrome</strong> (or the
      browser you used) and turn on <strong>Allow from this source</strong>.
    </>,
  ],
  [
    "Samsung",
    <>
      <strong>Settings → Apps → ⋮ (top right) → Special access → Install unknown apps → Chrome → Allow</strong>. If Auto Blocker is
      on, turn it off for the install in <strong>Settings → Security and privacy → Auto Blocker</strong>.
    </>,
  ],
  [
    "Xiaomi, Redmi, POCO",
    <>
      <strong>Settings → Apps → Manage apps → Chrome → Install unknown apps → Allow</strong>. When the security scan finishes, tap{" "}
      <strong>Continue installation</strong>.
    </>,
  ],
  [
    "Oppo, realme, OnePlus, vivo",
    <>
      <strong>Settings → Apps → Special app access → Install unknown apps → Chrome → Allow</strong>. If asked, confirm with your
      lock screen code.
    </>,
  ],
  [
    "Huawei, Honor",
    <>
      <strong>Settings → Security → More settings → Install apps from external sources → Chrome → Allow</strong>.
    </>,
  ],
];

export default function AndroidPage() {
  return (
    <Shell back={{ href: "/app", label: "← All phones" }}>
      <section className="max-w-xl space-y-6">
        <p className="text-xs font-bold uppercase tracking-[0.28em]" style={{ color: BRAND.accent }}>
          Move Score for Android
        </p>
        <h1 className={`${display.className} text-[2.3rem] leading-[0.95] sm:text-5xl`}>
          Download
          <br />
          and install
        </h1>
        <p className="text-base text-white/75 sm:text-lg">
          Get Move Score on Google Play. No Google Play on your phone? Download the app file below and install it in five steps.
          Same app, signed by {BRAND.name}.
        </p>
        <div className="grid max-w-md gap-3">
          <AndroidButton href={PLAY_STORE_URL} kicker="Get it on" label="Google Play" />
          <a href="/app/android/download" className="text-sm font-semibold text-white/70 underline underline-offset-4 hover:text-white">
            Or download the app file (APK · {ANDROID_APK.sizeMb} MB)
          </a>
        </div>
        <p className="text-xs text-white/50">
          Version {ANDROID_APK.version} (build {ANDROID_APK.build}) · {ANDROID_APK.builtOn} · Android 8 or newer.
        </p>
      </section>

      <section className="mt-16 space-y-6">
        <h2 className={`${display.className} text-2xl sm:text-3xl`}>Install in five steps</h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-black text-black"
                style={{ background: BRAND.accent }}
              >
                {i + 1}
              </span>
              <p className="mt-3 font-bold">{s.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-white/70">{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="font-bold">Turning on “unknown sources” by phone</p>
          <dl className="mt-3 divide-y divide-white/10">
            {PHONE_NOTES.map(([phone, how]) => (
              <div key={phone} className="grid gap-1 py-3 sm:grid-cols-[220px_1fr]">
                <dt className="text-sm font-semibold text-white">{phone}</dt>
                <dd className="text-sm leading-relaxed text-white/70">{how}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-white/50">
            After installing you can turn the switch off again; Move Score keeps working. To update, download from this page again and
            install over it: your follows, pass and sign-in stay.
          </p>
        </div>

        <div className="max-w-md">
          <AndroidButton href="/app/android/download" kicker="Download" label="Move Score" size />
        </div>
      </section>
    </Shell>
  );
}
