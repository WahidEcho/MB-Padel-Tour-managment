"use client";

import { useEffect, useState } from "react";
import { sizedImageSrc } from "@/lib/portrait";

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
    <img
      src={sizedImageSrc(logos[index], 640) ?? logos[index]}
      alt="Sponsor"
      loading="eager"
      className={`${className} object-contain transition-opacity duration-500`}
    />
  );
}
