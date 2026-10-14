import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { IconSlot } from './icon.js';
import { Pill } from './pill.js';
import { rovingTarget } from './roving.js';
import { Skeleton } from './skeleton.js';

export interface TabItem {
  readonly value: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** A short number shown beside the label, e.g. how many items the tab holds; it is part of the tab's name. */
  readonly count?: number;
  readonly disabled?: boolean;
  readonly content: ReactNode;
}

export interface TabsProps {
  label: string;
  value: string;
  items: readonly TabItem[];
  onChange: (value: string) => void;
  /** Shows the reserved shape of the panel instead of its content while it loads. */
  loading?: boolean;
  className?: string;
}

/** Tabs with automatic activation: arrow keys move focus and select, Home/End jump, and only the open panel is rendered. */
export function Tabs({ label, value, items, onChange, loading = false, className }: TabsProps) {
  const baseId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = items.map((item) => item.disabled !== true);
  const selected = items.findIndex((item) => item.value === value);
  const stop = selected !== -1 && enabled[selected] ? selected : enabled.indexOf(true);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = rovingTarget(event.key, index, enabled, false);
    if (target === null) return;
    event.preventDefault();
    refs.current[target]?.focus();
    onChange(items[target]!.value);
  };

  return (
    <div className={['ui-tabs', className].filter(Boolean).join(' ')}>
      <div role="tablist" aria-label={label} className="ui-tabs__list">
        {items.map((item, index) => (
          <button
            key={item.value}
            ref={(node) => { refs.current[index] = node; }}
            id={`${baseId}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={index === selected}
            aria-controls={index === selected ? `${baseId}-panel` : undefined}
            tabIndex={index === stop ? 0 : -1}
            disabled={item.disabled === true}
            className="ui-tabs__tab"
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.icon !== undefined && <IconSlot>{item.icon}</IconSlot>}
            {item.label}
            {item.count !== undefined && <Pill>{item.count}</Pill>}
          </button>
        ))}
      </div>
      {selected !== -1 && (
        <div
          role="tabpanel"
          id={`${baseId}-panel`}
          aria-labelledby={`${baseId}-tab-${selected}`}
          aria-busy={loading || undefined}
          tabIndex={0}
          className="ui-tabs__panel"
        >
          {loading ? <Skeleton className="ui-tabs__skeleton" /> : items[selected]!.content}
        </div>
      )}
    </div>
  );
}
