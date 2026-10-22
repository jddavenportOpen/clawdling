import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { useConnection } from '../src/connection';
import { colors } from '../src/theme';

export default function Index() {
  const { ready, connection } = useConnection();
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return <Redirect href={connection ? '/home' : '/connect'} />;
}
