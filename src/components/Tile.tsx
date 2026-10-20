export function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "gain" | "loss" | null;
}) {
  const bg = tone === "gain" ? "bg-gain/15 border-gain/30" : tone === "loss" ? "bg-loss/15 border-loss/30" : "bg-surface border-border";
  return (
    <div className={`rounded-2xl border p-4 ${bg}`}>
      <div className="text-sm text-ink-2">{label}</div>
      <div
        className={`mt-1 text-2xl font-bold leading-tight md:text-3xl ${tone === "gain" ? "text-gain" : tone === "loss" ? "text-loss" : "text-ink"}`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-sm text-ink-2">{sub}</div>}
    </div>
  );
}

export const toneOf = (n: number | null | undefined) => (n ? (n > 0 ? "gain" : "loss") : null);
