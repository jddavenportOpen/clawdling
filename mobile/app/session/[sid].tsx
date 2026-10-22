import { useLocalSearchParams } from 'expo-router';
import { RequireConnection } from '../../src/components/RequireConnection';
import { ChatScreen } from '../../src/screens/ChatScreen';

export default function SessionRoute() {
  const { sid } = useLocalSearchParams<{ sid: string }>();
  return (
    <RequireConnection>
      <ChatScreen key={String(sid)} sid={String(sid)} />
    </RequireConnection>
  );
}
