import { Redirect } from 'expo-router';
import { useRef, type ReactNode } from 'react';
import { View } from 'react-native';
import { useConnection } from '../connection';
import { colors } from '../theme';

/**
 * Screens behind this need a connection (real or demo). A screen opened without one goes to
 * Connect. A screen that loses its connection while open (Disconnect, a rejected code) just
 * blanks: the connection provider is already taking the user to Connect, and a second redirect
 * from here would race it.
 */
export function RequireConnection({ children }: { children: ReactNode }) {
  const { ready, connection } = useConnection();
  const had = useRef(false);
  if (connection) had.current = true;
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  if (!connection) return had.current ? <View style={{ flex: 1, backgroundColor: colors.bg }} /> : <Redirect href="/connect" />;
  return <>{children}</>;
}
