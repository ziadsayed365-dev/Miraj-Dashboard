"use client";

import { useEffect, useRef, useState } from "react";

export function MultiSelectFilter({
  options,
  selected,
  onChange,
  placeholder = "All",
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  const label = selected.length === 0 ? placeholder : `${selected.length} selected`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full truncate rounded border border-gray-200 bg-white px-1.5 py-1 text-left text-xs text-gray-700"
      >
        {label} ▾
      </button>
      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-56 overflow-y-auto rounded-md border border-gray-200 bg-white p-1 shadow-lg">
          <div className="flex justify-between px-1 py-1 text-[11px] text-gray-400">
            <button type="button" className="hover:text-gray-700" onClick={() => onChange(options.map((o) => o.value))}>
              Select all
            </button>
            <button type="button" className="hover:text-gray-700" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          {options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-gray-50">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
          {options.length === 0 && <div className="px-1.5 py-1 text-xs text-gray-400">No values</div>}
        </div>
      )}
    </div>
  );
}
