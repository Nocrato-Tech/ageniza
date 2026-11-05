import { lazy, Suspense } from 'react';
import { ActivityIndicator, View } from 'react-native';
import App from '../App';
import { presentationRoute } from './presentation/route';

const Presentation = lazy(() => import('./presentation/PresentationApp'));
export default function WebRoot() {
  if (!presentationRoute(window.location.pathname, process.env.EXPO_PUBLIC_PRESENTATION_FEATURES)) return <App />;
  return <Suspense fallback={<View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator accessibilityLabel="Abrindo apresentação" /></View>}><Presentation /></Suspense>;
}
