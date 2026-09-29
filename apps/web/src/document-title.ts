import { useEffect } from 'react';

/** Sets the browser tab title for a screen; the app ships one default title otherwise. */
export const useDocumentTitle = (title: string): void => {
  useEffect(() => {
    document.title = title;
  }, [title]);
};
