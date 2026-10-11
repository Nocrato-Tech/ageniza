import { useLayoutEffect } from 'react';
import { useLocation, useNavigate, type Location, type NavigateFunction } from 'react-router-dom';

/**
 * Reports the location a test can trust: the one that was committed. React Router 7 navigates inside
 * a transition, whose render is sliced and may yield right after the probe and before the commit, so a
 * probe that writes while rendering shows the new address while the screen still shows the old one
 * (#382, #405). A layout effect runs only for a commit, and before the test code resumes.
 */
export function useCommittedLocation(onCommit: (location: Location, navigate: NavigateFunction) => void): void {
  const location = useLocation();
  const navigate = useNavigate();
  useLayoutEffect(() => { onCommit(location, navigate); });
}
