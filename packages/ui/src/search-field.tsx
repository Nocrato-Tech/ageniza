import { forwardRef, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';

import { IconSlot } from './icon.js';
import { Kbd } from './kbd.js';

export type SearchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'size'> & {
  /** Names the field for assistive technology; the placeholder is only an example and never the name. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter was pressed: the owner decides what a search does with the text. */
  onSearch?: (value: string) => void;
  /** Shows "Ctrl K" and makes Ctrl+K (⌘K on a Mac) focus the field from anywhere on the page. */
  shortcut?: boolean;
};

/** A search in a pill: icon, field and the optional shortcut. Esc clears the text first and only then leaves the field. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { label, value, onChange, onSearch, shortcut = false, className, onKeyDown, ...props },
  ref
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!, []);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcut]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Enter' && onSearch !== undefined) {
      event.preventDefault();
      onSearch(value);
    } else if (event.key === 'Escape' && value !== '') {
      event.preventDefault();
      onChange('');
    }
  };

  return (
    <label className={['ui-search-field', className].filter(Boolean).join(' ')}>
      <IconSlot><Search /></IconSlot>
      <input
        {...props}
        ref={inputRef}
        type="search"
        className="ui-search-field__input"
        aria-label={label}
        aria-keyshortcuts={shortcut ? 'Control+K Meta+K' : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {shortcut && <Kbd aria-hidden="true">Ctrl K</Kbd>}
    </label>
  );
});
