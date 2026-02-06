"use client";

import { useEffect, useState } from "react";

export function KonamiCode() {
  const [showOwl, setShowOwl] = useState(false);

  useEffect(() => {
    // Konami code: ↑ ↑ ↓ ↓ ← → ← → B A
    const konamiCode = [
      "ArrowUp",
      "ArrowUp",
      "ArrowDown",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowLeft",
      "ArrowRight",
      "KeyB",
      "KeyA",
    ];

    let currentIndex = 0;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.code === konamiCode[currentIndex]) {
        currentIndex++;
        if (currentIndex === konamiCode.length) {
          setShowOwl(true);
          currentIndex = 0;
          // Hide owl after animation
          setTimeout(() => setShowOwl(false), 3000);
        }
      } else {
        currentIndex = 0;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!showOwl) return null;

  return (
    <div className="owl-flying" aria-hidden="true">
      🦉
    </div>
  );
}
