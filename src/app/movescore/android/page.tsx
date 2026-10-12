import type { Metadata } from "next";
import { Bullets, InlineLink, Mail, PageTitle, Section } from "../legal";
import { ANDROID_APK } from "./apk";

export const metadata: Metadata = {
  title: "Move Score for Android",
  description: "Download and install the Move Score app on an Android phone.",
};

/** Direct install for Android phones until the app is on Google Play. */
export default function Android() {
  return (
    <>
      <PageTitle
        eyebrow="Move Score"
        title="Move Score for Android"
        intro={<p>Until Move Score is on Google Play, install it straight from this page. It is the same app, signed by Move Beyond.</p>}
      />

      <section className="card space-y-3">
        <a
          href="/movescore/android/download"
          className="btn-primary min-h-12 px-6 text-base font-bold"
        >
          Download for Android
        </a>
        <p className="text-sm text-muted">
          Version {ANDROID_APK.version} (build {ANDROID_APK.build}) · about {ANDROID_APK.sizeMb} MB · {ANDROID_APK.builtOn}. Android 8 or newer.
        </p>
      </section>

      <Section title="Install it">
        <ol className="list-decimal space-y-1.5 pl-5 marker:text-muted">
          <li>Open this page on your Android phone in Chrome and tap <strong>Download for Android</strong>.</li>
          <li>When the download finishes, tap <strong>Open</strong> (or find it in Downloads).</li>
          <li>
            If your phone says it can&apos;t install apps from this source, tap <strong>Settings</strong>, turn on{" "}
            <strong>Allow from this source</strong>, then go back.
          </li>
          <li>
            Tap <strong>Install</strong>. If Google Play Protect asks about an unrecognised app, tap <strong>More details → Install anyway</strong>.
          </li>
          <li>Open Move Score and allow notifications to get match alerts.</li>
        </ol>
      </Section>

      <Section title="Good to know">
        <Bullets
          items={[
            "To update, download again from this page and install over the old version. Your follows, pass and sign-in stay.",
            "When Move Score arrives on Google Play, uninstall this version first and install it from Play; sign in again to bring back your follows and pass.",
            <>
              On iPhone? Move Score is coming to the App Store. Questions: <Mail subject="Move Score for Android" />, or see{" "}
              <InlineLink href="/movescore/support">support</InlineLink>.
            </>,
          ]}
        />
      </Section>
    </>
  );
}
