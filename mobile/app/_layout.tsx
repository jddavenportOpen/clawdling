import Ionicons from '@expo/vector-icons/Ionicons';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConnectionProvider, useConnection } from '../src/connection';
import { colors } from '../src/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

function Navigator({ fontsReady }: { fontsReady: boolean }) {
  const { ready } = useConnection();
  useEffect(() => {
    if (ready && fontsReady) SplashScreen.hideAsync().catch(() => {});
  }, [ready, fontsReady]);
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'default',
        gestureEnabled: true,
      }}
    >
      <Stack.Screen name="index" options={{ animation: 'none' }} />
      <Stack.Screen name="connect" options={{ animation: 'fade', gestureEnabled: false }} />
      <Stack.Screen name="home" options={{ animation: 'fade', gestureEnabled: false }} />
      <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="help" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(Ionicons.font);
  return (
    <SafeAreaProvider style={{ backgroundColor: colors.bg }}>
      <ConnectionProvider>
        <StatusBar style="light" />
        <Navigator fontsReady={fontsLoaded || !!fontError} />
      </ConnectionProvider>
    </SafeAreaProvider>
  );
}
