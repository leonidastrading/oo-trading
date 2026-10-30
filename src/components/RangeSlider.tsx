"use client";

/**
 * Two-handle slider for an optional [min, max] range. A handle at its end of the track means
 * "no limit" on that side (undefined).
 */
export function RangeSlider({
  lo,
  hi,
  step = 0.5,
  min,
  max,
  onChange,
  label,
  disabled,
}: {
  lo: number;
  hi: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (min: number | undefined, max: number | undefined) => void;
  label: string;
  disabled?: boolean;
}) {
  const a = min ?? lo;
  const b = max ?? hi;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const thumb =
    "pointer-events-none absolute inset-0 h-5 w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--loss)] [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--loss)] disabled:opacity-40";
  const text = min === undefined && max === undefined ? "any" : `${min ?? lo}–${max === undefined ? `${hi}+` : max}`;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-5 w-28">
        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-2" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--loss)] opacity-70"
          style={{ left: `${pct(a)}%`, right: `${100 - pct(b)}%` }}
        />
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={a}
          disabled={disabled}
          aria-label={`${label} minimum VIX`}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), b - step);
            onChange(v <= lo ? undefined : v, max);
          }}
          className={thumb}
        />
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={b}
          disabled={disabled}
          aria-label={`${label} maximum VIX`}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), a + step);
            onChange(min, v >= hi ? undefined : v);
          }}
          className={thumb}
        />
      </div>
      <span className={`w-14 text-xs tabular-nums ${min === undefined && max === undefined ? "text-muted" : "text-ink"}`}>{text}</span>
    </div>
  );
}
