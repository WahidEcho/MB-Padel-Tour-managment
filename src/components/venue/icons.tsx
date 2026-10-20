/** Small line icons for the venue map's categories and controls (24 × 24, stroke = currentColor). */
const PATHS: Record<string, string> = {
  toilet: "M7 3v6M7 3a2 2 0 1 1 0 .01M17 3a2 2 0 1 1 0 .01M5 9h4l-1 12M6 21l-1-6M17 9l-3 7h6l-3-7zM16 16v5M18 16v5",
  cup: "M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8zM16 10h2a2 2 0 0 1 0 4h-2M7 3c0 1.5 1 1.5 1 3M11 3c0 1.5 1 1.5 1 3",
  cross: "M9 3h6v6h6v6h-6v6H9v-6H3V9h6z",
  gate: "M3 21V8l9-5 9 5v13M7 21v-8h10v8M12 13v8",
  parking: "M5 3h14v18H5zM9 17V7h4a3 3 0 0 1 0 6H9",
  whistle: "M3 11a5 5 0 1 0 10 0h8V7H9a5 5 0 0 0-6 4zM8 11h.01",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7h.01",
  sofa: "M4 11V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v3M2 13a2 2 0 0 1 4 0v2h12v-2a2 2 0 0 1 4 0v5H2zM5 18v2M19 18v2",
  prayer: "M12 3c3 3 5 6 5 9a5 5 0 0 1-10 0c0-3 2-6 5-9zM5 21h14M12 17v4",
  pin: "M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  court: "M4 3h16v18H4zM4 12h16M8 3v18M16 3v18M8 7.5h8M8 16.5h8",
  camera: "M3 7h11v10H3zM14 10l7-4v12l-7-4",
  star: "M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z",
  locate: "M12 2v3M12 19v3M2 12h3M19 12h3M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  compass: "M12 2l4 10-4 10-4-10z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  close: "M6 6l12 12M18 6L6 18",
  walk: "M13 4a1.5 1.5 0 1 0 0 .01M10 21l2-6 3 3v3M9 12l2-4 4 2 2 3M11 8l-3 2-1 4",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  left: "M14 6l-6 6 6 6",
  right: "M10 6l6 6-6 6",
  up: "M6 14l6-6 6 6",
  flag: "M5 21V4h11l-2 4 2 4H5",
};

export function Icon({ name, size = 18, stroke = 2, className }: { name: string; size?: number; stroke?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.pin} />
    </svg>
  );
}
