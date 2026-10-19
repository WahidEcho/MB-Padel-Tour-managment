/**
 * The page the in-app YouTube player runs in (react-native-webview). Pure, so
 * it is tested without a phone.
 *
 * The YouTube IFrame API, on the nocookie host, inside a page whose base URL is
 * Move Score's own site: YouTube refuses embeds that send no referrer (error
 * 153), and an inline HTML page has none of its own. The page reports the
 * player's state and errors back to the app (window.ReactNativeWebView), which
 * shows "Open on YouTube" when the owner switched embedding off, the stream has
 * ended or the API cannot load.
 */
import { isYouTubeId } from "@core";

export type PlayerMessage =
  | { type: "ready" }
  | { type: "state"; state: number }
  | { type: "error"; code: number }
  | { type: "api_failed" };

export function parsePlayerMessage(raw: string): PlayerMessage | null {
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (m.type === "ready" || m.type === "api_failed") return { type: m.type };
    if (m.type === "state" && typeof m.state === "number") return { type: "state", state: m.state };
    if (m.type === "error" && typeof m.code === "number") return { type: "error", code: m.code };
    return null;
  } catch {
    return null;
  }
}

/** Null for anything that is not a YouTube video id: nothing else is ever written into the page. */
export function liveVideoHtml(youtubeId: string, origin: string): string | null {
  if (!isYouTubeId(youtubeId)) return null;
  const safeOrigin = /^https?:\/\/[a-z0-9.:-]+$/i.test(origin) ? origin : "https://tour.mbeg.org";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{position:absolute;inset:0;width:100%;height:100%}</style></head>
<body><div id="p"></div><script>
function post(m){try{window.ReactNativeWebView.postMessage(JSON.stringify(m))}catch(e){}}
var t=document.createElement("script");t.src="https://www.youtube.com/iframe_api";t.onerror=function(){post({type:"api_failed"})};document.head.appendChild(t);
setTimeout(function(){if(!window.YT||!window.YT.Player)post({type:"api_failed"})},12000);
function onYouTubeIframeAPIReady(){new YT.Player("p",{videoId:"${youtubeId}",host:"https://www.youtube-nocookie.com",
playerVars:{playsinline:1,rel:0,modestbranding:1,autoplay:1,origin:"${safeOrigin}"},
events:{onReady:function(){post({type:"ready"})},onError:function(e){post({type:"error",code:e.data})},onStateChange:function(e){post({type:"state",state:e.data})}}})}
</script></body></html>`;
}
