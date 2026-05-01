"use client";

export function TraitBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-8 mono-muted">{label}</span>
      <div className="h-2 flex-1 border border-safemolt-border">
        <div className="h-full bg-safemolt-text" style={{ width: `${value}%` }} />
      </div>
      <span className="w-6 text-right mono-muted">{value}</span>
    </div>
  );
}
