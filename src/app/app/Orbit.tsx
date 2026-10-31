import type { ReactNode } from "react";
import "./orbit.css";

/**
 * The tour.mbeg.org/app page, design C "Orbit" (owner's pick, 28 Oct 2026): a starfield, a turning
 * 3D phone whose screen changes every 3 s through what fans get (live score, stats, lock screen,
 * alerts, the tie card), nations and alerts circling it, and a match-day timeline. Pure CSS
 * animation (orbit.css, ms- classes), still under prefers-reduced-motion. The scores shown are
 * illustrations. `buttons` are the two store links, the visitor's phone first.
 */

/** The Move Score mark (from "MOVE SCORE LOGO.ai"). `ink` colours the swoosh (white on the dark Orbit page). */
export function Mark({ size, label = false, ink = "#FFFFFF" }: { size: number; label?: boolean; ink?: string }) {
  return (
    <svg width={size} height={size} viewBox="120 315 600 550" style={{ flex: "none" }} {...(label ? { role: "img", "aria-label": "Move Score" } : { "aria-hidden": true })}>
      <path fill={ink} d="M 149.52 613.99 C 259.55 569.42 313.73 467.25 404.27 386.44 C 447.41 347.94 495.99 323.88 597.34 343.61 C 623.81 348.76 644.87 357.21 659.02 363.89 C 644.34 365.06 622.76 368.05 598.19 376.56 C 561.11 389.39 535.54 408.42 506.09 433.17 C 421.77 504.02 413.19 522.25 358.23 568.36 C 316.77 603.14 285.30 608.79 269.51 613.14 C 219.75 626.86 180.27 620.58 171.49 619.06 C 162.37 617.48 154.85 615.53 149.52 613.99 "></path><path fill="#D1DD26" d="M 601.08 477.44 C 601.08 446.41 626.24 421.25 657.27 421.25 C 688.30 421.25 713.46 446.41 713.46 477.44 C 713.46 508.47 688.30 533.62 657.27 533.62 C 626.24 533.62 601.08 508.47 601.08 477.44 "></path><path fill="#D1DD26" d="M 406.54 568.94 C 431.81 560.23 476.85 549.15 527.60 561.51 C 545.24 565.80 576.53 573.85 595.56 599.73 C 600.01 605.78 608.46 617.60 609.37 634.78 C 609.96 645.85 607.19 654.90 604.83 660.60 C 604.35 661.75 603.67 662.80 602.81 663.70 C 554.99 713.70 510.83 750.07 477.69 774.95 C 435.64 806.52 413.91 822.56 378.93 835.48 C 316.26 858.64 261.00 853.81 236.63 851.41 C 189.82 846.82 152.71 833.58 128.31 822.74 C 140.71 822.16 158.44 820.64 179.28 816.37 C 243.45 803.21 284.03 774.85 349.19 728.23 C 349.19 728.23 443.26 660.92 444.77 622.03 C 445.35 606.93 439.46 597.61 439.46 597.61 C 439.46 597.61 435.78 592.34 421.41 580.62 C 415.27 575.62 410.10 571.63 406.54 568.94 "></path>
    </svg>
  );
}

export function OrbitPage({ buttons, displayFont }: { buttons: ReactNode; displayFont: string }) {
  return (
    <div className="ms-root" style={{ ["--ms-display" as string]: displayFont }}>
<div style={{ position: "relative", overflow: "hidden", minHeight: "100vh", background: "radial-gradient(900px 700px at 50% 32%, #16124a 0%, #04040c 65%)", color: "#ffffff", fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>
  <div className="ms-stars" aria-hidden></div>
  <div className="ms-stars ms-b" aria-hidden></div>

  <header style={{ position: "relative", zIndex: "2", maxWidth: "1200px", margin: "0 auto", padding: "28px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
    <span style={{ display: "inline-flex", alignItems: "center", gap: "12px" }}><Mark size={40} label /><span style={{ lineHeight: "1.05" }}><span className="ms-disp" style={{ display: "block", fontSize: "20px", letterSpacing: "0.12em" }}>MOVE SCORE</span><span style={{ display: "block", fontSize: "11px", letterSpacing: "0.22em", color: "rgba(255,255,255,0.55)" }}>BY MOVE BEYOND</span></span></span>
    <a href="https://tour.mbeg.org" style={{ fontSize: "14px", fontWeight: "600", textDecoration: "none" }}>tour.mbeg.org</a>
  </header>

  <section style={{ position: "relative", zIndex: "2", textAlign: "center", padding: "20px 24px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "18px" }}>
    <p style={{ margin: "0", color: "#FCFC00", fontSize: "12px", fontWeight: "700", letterSpacing: "0.3em" }}>MOVE SCORE APP</p>
    <h1 className="ms-disp" style={{ margin: "0", fontSize: "clamp(34px, 9.5vw, 80px)", lineHeight: "0.95" }}>Your match.<br />Wherever you are.</h1>
  </section>

  <section style={{ position: "relative", zIndex: "1", overflow: "hidden" }}>
    <div className="ms-space" role="img" aria-label="A turning phone showing a live match, with nations and alerts circling it">
      <div className="ms-wm" aria-hidden><Mark size={620} /></div>
      <div className="ms-orbit ms-o2" aria-hidden></div>
      <div className="ms-orbit ms-o1" aria-hidden>
        <div className="ms-sat" style={{ background: "linear-gradient(#ce1126 33%, #fff 33% 66%, #000 66%)" }}></div>
        <div className="ms-sat" style={{ top: "auto", bottom: "-22px", background: "linear-gradient(#aa151b 25%, #f1bf00 25% 75%, #aa151b 75%)" }}></div>
        <div className="ms-sat" style={{ top: "50%", left: "-22px", margin: "-22px 0 0", background: "linear-gradient(90deg, #002395 33%, #fff 33% 66%, #ed2939 66%)" }}></div>
        <div className="ms-sat" style={{ top: "50%", left: "auto", right: "-22px", margin: "-22px 0 0", background: "radial-gradient(circle, #bc002d 28%, #ffffff 30%)" }}></div>
      </div>
      <div className="ms-pill ms-p1" style={{ left: "calc(50% - 420px)", top: "140px" }}><span style={{ color: "#FCFC00", fontWeight: "700" }}>Match soon</span> · Court 13</div>
      <div className="ms-pill ms-p2" style={{ left: "calc(50% + 200px)", top: "210px", animationDelay: "-2s" }}><span style={{ color: "#ff4d6a", fontWeight: "700" }}>Live</span> · Egypt v Spain</div>
      <div className="ms-pill ms-p3" style={{ left: "calc(50% - 380px)", top: "520px", animationDelay: "-4s" }}><span style={{ color: "#4d9bff", fontWeight: "700" }}>Result</span> · 6-4 6-3</div>
      <div className="ms-pill ms-p4" style={{ left: "calc(50% + 230px)", top: "560px", animationDelay: "-1s" }}>Ace · Egypt</div>
      <div className="ms-floor" aria-hidden></div>
      <div className="ms-stage-scale" style={{ transformStyle: "preserve-3d" }}>
      <div className="ms-turn">
        <div className="ms-back" aria-hidden><div className="ms-cam"></div><span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "14px" }}><Mark size={110} /><span className="ms-disp" style={{ fontSize: "14px", letterSpacing: "0.2em", color: "rgba(255,255,255,0.45)" }}>MOVE SCORE</span></span></div>
        <div className="ms-body ms-l7" aria-hidden></div>
        <div className="ms-body ms-l6" aria-hidden></div>
        <div className="ms-body ms-l5" aria-hidden></div>
        <div className="ms-body ms-l4" aria-hidden></div>
        <div className="ms-body ms-l3" aria-hidden></div>
        <div className="ms-body ms-l2" aria-hidden></div>
        <div className="ms-body ms-l1" aria-hidden></div>
        <div className="ms-key" style={{ left: "-4px", top: "120px", height: "34px" }} aria-hidden></div>
        <div className="ms-key" style={{ left: "-4px", top: "170px", height: "60px" }} aria-hidden></div>
        <div className="ms-key" style={{ left: "-4px", top: "240px", height: "60px" }} aria-hidden></div>
        <div className="ms-key" style={{ right: "-4px", top: "190px", height: "90px" }} aria-hidden></div>
        <div className="ms-rim" aria-hidden></div>
        <div className="ms-shine" aria-hidden></div>
        <div className="ms-ph">
          <div className="ms-isl"></div>
          <div className="ms-glare"></div>
          <div className="ms-slide ms-first" style={{ animationDelay: "0s" }}>
            <p style={{ margin: "0 0 12px", fontSize: "10px", letterSpacing: "0.2em", color: "rgba(255,255,255,0.5)" }}>COURT 13 · LIVE</p>
            <div style={{ borderRadius: "20px", background: "#12162a", padding: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}><span style={{ width: "8px", height: "8px", borderRadius: "4px", background: "#FCFC00" }}></span><span style={{ width: "22px", height: "15px", borderRadius: "3px", background: "linear-gradient(#ce1126 33%, #fff 33% 66%, #000 66%)" }}></span><span style={{ flex: "1", fontWeight: "700" }}>Egypt</span><span style={{ color: "rgba(255,255,255,0.6)" }}>6</span><span>3</span><span className="ms-disp" style={{ minWidth: "38px", textAlign: "center", padding: "4px 0", borderRadius: "8px", background: "rgba(252,252,0,0.15)", color: "#FCFC00" }}>40</span></div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}><span style={{ width: "8px", height: "8px" }}></span><span style={{ width: "22px", height: "15px", borderRadius: "3px", background: "linear-gradient(#aa151b 25%, #f1bf00 25% 75%, #aa151b 75%)" }}></span><span style={{ flex: "1", fontWeight: "700" }}>Spain</span><span style={{ color: "rgba(255,255,255,0.6)" }}>4</span><span>2</span><span className="ms-disp" style={{ minWidth: "38px", textAlign: "center", padding: "4px 0", borderRadius: "8px", background: "rgba(255,255,255,0.08)" }}>15</span></div>
            </div>
            <div style={{ marginTop: "12px", borderRadius: "16px", background: "linear-gradient(135deg, #1a2350, #0f1428)", height: "170px", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}><span style={{ position: "absolute", top: "10px", left: "10px", fontSize: "10px", fontWeight: "700", color: "#ff4d6a" }}>LIVE VIDEO</span><svg width="46" height="46" viewBox="0 0 24 24" fill="#ffffff" aria-hidden><path d="M8 5v14l11-7z"></path></svg></div>
            <p style={{ margin: "14px 0 0", textAlign: "center", fontWeight: "700", fontSize: "15px" }}>Every point, live</p>
          </div>
          <div className="ms-slide" style={{ animationDelay: "3s" }}>
            <p style={{ margin: "0 0 12px", fontSize: "10px", letterSpacing: "0.2em", color: "rgba(255,255,255,0.5)" }}>MATCH STATS</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "14px", fontSize: "13px" }}>
              <div><div style={{ display: "flex", justifyContent: "space-between" }}><span>4</span><span style={{ color: "rgba(255,255,255,0.55)" }}>Aces</span><span>2</span></div><div style={{ display: "flex", gap: "4px", marginTop: "6px" }}><span style={{ flex: "4", height: "6px", borderRadius: "3px", background: "#FCFC00" }}></span><span style={{ flex: "2", height: "6px", borderRadius: "3px", background: "#4d9bff" }}></span></div></div>
              <div><div style={{ display: "flex", justifyContent: "space-between" }}><span>2/3</span><span style={{ color: "rgba(255,255,255,0.55)" }}>Break points</span><span>0/1</span></div><div style={{ display: "flex", gap: "4px", marginTop: "6px" }}><span style={{ flex: "3", height: "6px", borderRadius: "3px", background: "#FCFC00" }}></span><span style={{ flex: "1", height: "6px", borderRadius: "3px", background: "#4d9bff" }}></span></div></div>
              <div><div style={{ display: "flex", justifyContent: "space-between" }}><span>38</span><span style={{ color: "rgba(255,255,255,0.55)" }}>Points won</span><span>29</span></div><div style={{ display: "flex", gap: "4px", marginTop: "6px" }}><span style={{ flex: "38", height: "6px", borderRadius: "3px", background: "#FCFC00" }}></span><span style={{ flex: "29", height: "6px", borderRadius: "3px", background: "#4d9bff" }}></span></div></div>
              <div style={{ borderRadius: "16px", background: "#12162a", padding: "12px" }}><p style={{ margin: "0 0 8px", fontSize: "10px", letterSpacing: "0.18em", color: "rgba(255,255,255,0.5)" }}>MOMENTUM</p><div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "50px" }}><span style={{ flex: "1", height: "30%", background: "#FCFC00", borderRadius: "2px" }}></span><span style={{ flex: "1", height: "55%", background: "#FCFC00", borderRadius: "2px" }}></span><span style={{ flex: "1", height: "20%", background: "#4d9bff", borderRadius: "2px" }}></span><span style={{ flex: "1", height: "70%", background: "#FCFC00", borderRadius: "2px" }}></span><span style={{ flex: "1", height: "40%", background: "#4d9bff", borderRadius: "2px" }}></span><span style={{ flex: "1", height: "85%", background: "#FCFC00", borderRadius: "2px" }}></span><span style={{ flex: "1", height: "95%", background: "#FCFC00", borderRadius: "2px" }}></span></div></div>
            </div>
            <p style={{ margin: "14px 0 0", textAlign: "center", fontWeight: "700", fontSize: "15px" }}>Stats and momentum</p>
          </div>
          <div className="ms-slide" style={{ animationDelay: "6s", background: "radial-gradient(circle at 50% 15%, #1b3a7a, #070b1c 70%)" }}>
            <p className="ms-disp" style={{ margin: "24px 0 0", textAlign: "center", fontSize: "62px", fontWeight: "700" }}>9:41</p>
            <p style={{ margin: "2px 0 0", textAlign: "center", fontSize: "13px", color: "rgba(255,255,255,0.7)" }}>Tuesday 28 October</p>
            <div style={{ marginTop: "60px", borderRadius: "22px", background: "rgba(15,18,30,0.88)", padding: "14px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", letterSpacing: "0.12em", color: "rgba(255,255,255,0.65)" }}><span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Mark size={16} />MOVE SCORE · COURT 13</span><span style={{ color: "#ff4d6a" }}>LIVE</span></div>
              <div style={{ display: "flex", gap: "8px", fontWeight: "700" }}><span style={{ flex: "1" }}>Egypt</span><span style={{ color: "rgba(255,255,255,0.7)" }}>6 3</span><span style={{ color: "#FCFC00" }}>40</span></div>
              <div style={{ display: "flex", gap: "8px", fontWeight: "700" }}><span style={{ flex: "1" }}>Spain</span><span style={{ color: "rgba(255,255,255,0.7)" }}>4 2</span><span style={{ color: "#FCFC00" }}>15</span></div>
            </div>
            <p style={{ margin: "18px 0 0", textAlign: "center", fontWeight: "700", fontSize: "15px" }}>On your lock screen</p>
          </div>
          <div className="ms-slide" style={{ animationDelay: "9s" }}>
            <p style={{ margin: "0 0 12px", fontSize: "10px", letterSpacing: "0.2em", color: "rgba(255,255,255,0.5)" }}>ALERTS</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ borderRadius: "16px", background: "#12162a", padding: "12px" }}><p style={{ margin: "0", fontSize: "11px", color: "#FCFC00", fontWeight: "700" }}>MATCH SOON</p><p style={{ margin: "4px 0 0", fontSize: "13px" }}>Egypt v Spain is next on Court 13.</p></div>
              <div style={{ borderRadius: "16px", background: "#12162a", padding: "12px" }}><p style={{ margin: "0", fontSize: "11px", color: "#ff4d6a", fontWeight: "700" }}>LIVE NOW</p><p style={{ margin: "4px 0 0", fontSize: "13px" }}>Egypt v Spain has started.</p></div>
              <div style={{ borderRadius: "16px", background: "#12162a", padding: "12px" }}><p style={{ margin: "0", fontSize: "11px", color: "#4d9bff", fontWeight: "700" }}>RESULT</p><p style={{ margin: "4px 0 0", fontSize: "13px" }}>Egypt win the doubles 6-4 6-3.</p></div>
            </div>
            <p style={{ margin: "16px 0 0", textAlign: "center", fontWeight: "700", fontSize: "15px" }}>Follow your players and nations</p>
          </div>
          <div className="ms-slide" style={{ animationDelay: "12s" }}>
            <p style={{ margin: "0 0 12px", fontSize: "10px", letterSpacing: "0.2em", color: "rgba(255,255,255,0.5)" }}>JUNIOR TEAM FINALS · TIE</p>
            <div style={{ borderRadius: "20px", background: "#12162a", padding: "14px", textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center" }}>
                <div><div style={{ width: "44px", height: "30px", borderRadius: "5px", margin: "0 auto", background: "linear-gradient(#ce1126 33%, #fff 33% 66%, #000 66%)" }}></div><p style={{ margin: "6px 0 0", fontWeight: "700" }}>EGY</p></div>
                <p className="ms-disp" style={{ margin: "0", fontSize: "44px" }}>2<span style={{ color: "rgba(255,255,255,0.35)" }}>–</span>1</p>
                <div><div style={{ width: "44px", height: "30px", borderRadius: "5px", margin: "0 auto", background: "linear-gradient(#aa151b 25%, #f1bf00 25% 75%, #aa151b 75%)" }}></div><p style={{ margin: "6px 0 0", fontWeight: "700" }}>ESP</p></div>
              </div>
              <p style={{ margin: "8px 0 0", fontSize: "11px", color: "rgba(255,255,255,0.55)" }}>Egypt win the tie</p>
            </div>
            <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "12px", borderRadius: "14px", background: "#12162a" }}><span>Singles 2</span><span style={{ color: "#FCFC00", fontWeight: "700" }}>EGY 6-3 6-4</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "12px", borderRadius: "14px", background: "#12162a" }}><span>Singles 1</span><span style={{ color: "#4d9bff", fontWeight: "700" }}>ESP 7-5 6-2</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "12px", borderRadius: "14px", background: "#12162a" }}><span>Doubles</span><span style={{ color: "#FCFC00", fontWeight: "700" }}>EGY 6-4 6-3</span></div>
            </div>
            <div style={{ marginTop: "12px", borderRadius: "14px", background: "#FCFC00", color: "#05060f", textAlign: "center", padding: "12px", fontWeight: "700", fontSize: "13px" }}>Share the tie card</div>
          </div>
          <div className="ms-dots" aria-hidden><span style={{ animationDelay: "0s" }}></span><span style={{ animationDelay: "3s" }}></span><span style={{ animationDelay: "6s" }}></span><span style={{ animationDelay: "9s" }}></span><span style={{ animationDelay: "12s" }}></span></div>
        </div>
      </div>
      </div>
    </div>
  </section>

  <section style={{ position: "relative", zIndex: "2", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 300px))", justifyContent: "center", gap: "12px", padding: "0 24px 100px" }}>
    {buttons}
  </section>

  <section style={{ position: "relative", zIndex: "2", maxWidth: "900px", margin: "0 auto", padding: "40px 24px 120px", display: "flex", flexDirection: "column", gap: "40px" }}>
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <p style={{ margin: "0", color: "#FCFC00", fontSize: "12px", fontWeight: "700", letterSpacing: "0.3em", display: "flex", alignItems: "center", gap: "10px" }}><Mark size={22} />A MATCH DAY WITH MOVE SCORE</p>
      <h2 className="ms-disp" style={{ margin: "0", fontSize: "clamp(30px, 4vw, 50px)", lineHeight: "1" }}><span style={{ fontWeight: "normal" }}>From the first serve<br /></span>to the final card.</h2>
    </div>
    <div className="ms-step"><div className="ms-dot"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#FCFC00" strokeWidth="1.8" strokeLinecap="round" aria-hidden><rect x="3" y="4" width="18" height="17" rx="3"></rect><path d="M3 9h18M8 2v4M16 2v4"></path></svg></div><div><h3 style={{ margin: "6px 0 6px", fontSize: "21px" }}>Morning: the order of play</h3><p style={{ margin: "0", color: "rgba(255,255,255,0.7)", lineHeight: "1.55" }}>Every court and every tie for the day, by court or by time.</p></div></div>
    <div className="ms-step"><div className="ms-dot"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#FCFC00" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"></path><path d="M10 20a2 2 0 0 0 4 0"></path></svg></div><div><h3 style={{ margin: "6px 0 6px", fontSize: "21px" }}>Match soon</h3><p style={{ margin: "0", color: "rgba(255,255,255,0.7)", lineHeight: "1.55" }}>A nudge when the players and nations you follow are about to go on.</p></div></div>
    <div className="ms-step"><div className="ms-dot"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#FCFC00" strokeWidth="1.8" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="9"></circle><path d="M5 5c4 4 4 10 0 14M19 5c-4 4-4 10 0 14"></path></svg></div><div><h3 style={{ margin: "6px 0 6px", fontSize: "21px" }}>Live, point by point</h3><p style={{ margin: "0", color: "rgba(255,255,255,0.7)", lineHeight: "1.55" }}>Who serves, the score, the momentum, the stats, and the live video when the court is streamed.</p></div></div>
    <div className="ms-step"><div className="ms-dot"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#FCFC00" strokeWidth="1.8" strokeLinecap="round" aria-hidden><rect x="6" y="2" width="12" height="20" rx="3"></rect><path d="M9 14h6"></path></svg></div><div><h3 style={{ margin: "6px 0 6px", fontSize: "21px" }}>On your lock screen</h3><p style={{ margin: "0", color: "rgba(255,255,255,0.7)", lineHeight: "1.55" }}>Lock your iPhone and the score keeps going.</p></div></div>
    <div className="ms-step"><div className="ms-dot"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#FCFC00" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"></path><path d="M16 6l-4-4-4 4M12 2v13"></path></svg></div><div><h3 style={{ margin: "6px 0 6px", fontSize: "21px" }}>Share the win</h3><p style={{ margin: "0", color: "rgba(255,255,255,0.7)", lineHeight: "1.55" }}>The result as a card for Move Score Stories, Instagram or WhatsApp.</p></div></div>
  </section>

  <footer style={{ position: "relative", zIndex: "2", maxWidth: "1200px", margin: "0 auto", padding: "0 24px 48px", fontSize: "13px", color: "rgba(255,255,255,0.5)", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px" }}><Mark size={56} label /><p style={{ margin: 0 }}>Move Score by <a href="https://mbeg.org">Move Beyond</a> · Free, no ads · iPhone iOS 16.4+ · Android 8+</p>
    <nav aria-label="Move Score pages" style={{ display: "flex", gap: "18px", flexWrap: "wrap", justifyContent: "center" }}>
      <a href="/movescore">About</a>
      <a href="/movescore/support">Support</a>
      <a href="/movescore/privacy">Privacy</a>
      <a href="/movescore/terms">Terms</a>
    </nav>
  </footer>
</div>
    </div>
  );
}
