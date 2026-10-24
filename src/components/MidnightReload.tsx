"use client";

import { useEffect } from "react";
import { todayET } from "@/lib/time";

/**
 * Full page reload (like F5) once the ET date changes, so a tab left open picks up new
 * code and starts the day clean. Checked every minute and on wake, so a device that was
 * asleep at midnight reloads as soon as it's back.
 */
export function MidnightReload() {
  useEffect(() => {
    const loadedOn = todayET();
    const check = () => {
      if (todayET() !== loadedOn) window.location.reload();
    };
    const timer = setInterval(check, 60_000);
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", check);
    };
  }, []);
  return null;
}
