import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useConnection } from '../connection';
import { colors } from '../theme';

/** Screens behind this need a connection (real or demo); without one they go to Connect. */
export function RequireConnection({ children }: { children: ReactNode }) {
  const { ready, connection } = useConnection();
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  if (!connection) return <Redirect href="/connect" />;
  return <>{children}</>;
}
