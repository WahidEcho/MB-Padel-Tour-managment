"use client";

import { useEffect, useState } from "react";

/** Rotates sponsor logos every `seconds` (spec §17.7, default 10s). */
export default function SponsorRotator({
  logos,
  seconds = 10,
  className = "h-16",
}: {
  logos: string[];
  seconds?: number;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (logos.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % logos.length), seconds * 1000);
    return () => clearInterval(id);
  }, [logos.length, seconds]);
  if (logos.length === 0) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={logos[index]} alt="Sponsor" className={`${className} object-contain transition-opacity duration-500`} />
  );
}
