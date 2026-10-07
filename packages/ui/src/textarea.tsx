import { forwardRef, type TextareaHTMLAttributes } from 'react';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Native textarea passthrough: the platform owns scrolling and keyboard behaviour, the label
 *  binds like every form field, and the shared `ui-textarea` class carries the Ageniza tokens. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={['ui-textarea', className].filter(Boolean).join(' ')} {...props} />;
});
