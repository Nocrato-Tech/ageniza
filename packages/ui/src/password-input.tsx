import { forwardRef, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { IconButton } from './button.js';

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { id, className, disabled, onKeyDown, onKeyUp, onBlur, 'aria-describedby': describedBy, ...props }, ref
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selection = useRef<{ start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null; focused: boolean } | null>(null);
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const capsId = `${inputId}-caps-lock`;
  const updateCapsLock = (event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState('CapsLock'));

  useLayoutEffect(() => {
    const input = inputRef.current;
    const previous = selection.current;
    if (input === null || previous === null) return;
    if (previous.focused) input.focus({ preventScroll: true });
    input.setSelectionRange(previous.start, previous.end, previous.direction ?? undefined);
    selection.current = null;
  }, [visible]);

  return <div className="ui-password-field"><div className="ui-password-input">
    <input
      {...props}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      id={inputId}
      aria-describedby={[describedBy, capsLock && capsId].filter(Boolean).join(' ') || undefined}
      onKeyDown={(event) => { updateCapsLock(event); onKeyDown?.(event); }}
      onKeyUp={(event) => { updateCapsLock(event); onKeyUp?.(event); }}
      onBlur={(event) => { setCapsLock(false); onBlur?.(event); }}
      ref={(element) => {
        inputRef.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref !== null) ref.current = element;
      }}
      type={visible ? 'text' : 'password'}
      disabled={disabled}
      className={['ui-text-input', className].filter(Boolean).join(' ')}
    />
    <IconButton
      className="ui-password-input__toggle"
      label={visible ? 'Ocultar senha' : 'Mostrar senha'}
      icon={visible ? <EyeOff /> : <Eye />}
      aria-controls={inputId}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const input = inputRef.current;
        if (input !== null) selection.current = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, focused: document.activeElement === input };
        setVisible((current) => !current);
      }}
    />
  </div>
    {capsLock && <p id={capsId} className="ui-field__hint" role="status">Caps Lock ativado.</p>}
  </div>;
});
