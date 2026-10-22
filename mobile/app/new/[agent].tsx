import { useLocalSearchParams } from 'expo-router';
import { RequireConnection } from '../../src/components/RequireConnection';
import { ChatScreen } from '../../src/screens/ChatScreen';

export default function NewSessionRoute() {
  const { agent } = useLocalSearchParams<{ agent: string }>();
  return (
    <RequireConnection>
      <ChatScreen key={`new:${String(agent)}`} agentId={String(agent)} />
    </RequireConnection>
  );
}
