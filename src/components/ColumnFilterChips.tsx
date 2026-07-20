"use client";

import { useState } from "react";

export interface ColumnFilterDef<T> {
  key: string;
  label: string;
  getValue: (item: T) => string;
}

interface Props<T> {
  items: T[];
  columns: ColumnFilterDef<T>[];
  active: Record<string, string>;
  onChange: (key: string, value: string | null) => void;
}

export function applyColumnFilters<T>(
  items: T[],
  columns: ColumnFilterDef<T>[],
  active: Record<string, string>,
  excludeKey?: string
): T[] {
  return items.filter(item =>
    columns.every(col => {
      if (col.key === excludeKey) return true;
      const val = active[col.key];
      if (!val) return true;
      return col.getValue(item) === val;
    })
  );
}

export default function ColumnFilterChips<T>({ items, columns, active, onChange }: Props<T>) {
  const [open, setOpen] = useState(false);
  const activeCount = Object.values(active).filter(Boolean).length;

  const groups = columns
    .map(col => {
      const scoped = applyColumnFilters(items, columns, active, col.key);
      const counts = new Map<string, number>();
      scoped.forEach(item => {
        const v = col.getValue(item);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      });
      const values = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      return { col, values };
    })
    .filter(g => g.values.length > 1);

  if (groups.length === 0) return null;

  return (
    <div>
      <button className="column-filters-toggle" onClick={() => setOpen(o => !o)}>
        {open ? "▴" : "▾"} Filter by column
        {activeCount > 0 && <span className="chip-count">{activeCount} active</span>}
      </button>
      {open && (
        <div className="column-filters" style={{ marginTop: 8 }}>
          {groups.map(({ col, values }) => (
            <div key={col.key} className="column-filter-group">
              <span className="column-filter-label">{col.label}</span>
              {values.map(([val, count]) => (
                <button
                  key={val}
                  className={`column-filter-chip ${active[col.key] === val ? "active" : ""}`}
                  onClick={() => onChange(col.key, active[col.key] === val ? null : val)}
                >
                  {val}
                  <span className="column-filter-chip-count">{count}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
