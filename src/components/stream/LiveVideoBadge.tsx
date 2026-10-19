/** The ● LIVE VIDEO badge on a match whose court is streamed right now (words and dot: never colour alone). */
export default function LiveVideoBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-[#e5133a] px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-white ${className}`}
      data-testid="live-video-badge"
    >
      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
      Live video
    </span>
  );
}
