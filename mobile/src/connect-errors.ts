// What to tell a person when pairing fails, in words that point at the fix. Pure, unit-tested.

import type { ConnectionCheck } from './api';
import type { ServerAddress } from './links';

export interface ConnectProblem {
  title: string;
  message: string;
}

const LAN_HINT =
  'On your computer, run `clawdling start --host 0.0.0.0`, keep your phone on the same Wi-Fi, and allow Local Network access for Clawdling in iOS Settings.';

/** iOS blocks plain http to internet names (App Transport Security): say so before trying. */
export function atsProblem(address: ServerAddress): ConnectProblem | null {
  if (!address.atsBlocked) return null;
  return {
    title: 'iOS needs a secure address for that server',
    message: `${address.host} is an internet name, and iOS only allows https:// for those. Use your computer's local IP address (on the same Wi-Fi), its Tailscale IP (it starts with 100.), or an https:// address.`,
  };
}

export function connectProblem(address: ServerAddress, check: ConnectionCheck): ConnectProblem | null {
  if (check.ok) return null;
  const e = check.error;
  const where = address.hostPort;
  if (!e) return { title: 'Could not connect', message: 'Something went wrong. Try again.' };

  if (check.step === 'health') {
    if (e.kind === 'network' || e.kind === 'timeout') {
      const slow = e.kind === 'timeout';
      if (address.network === 'loopback') {
        return {
          title: `This link points at ${address.host}`,
          message:
            'On a phone, that address means the phone itself, not your computer. On your computer, restart with `clawdling start --host 0.0.0.0`, then scan the new code.',
        };
      }
      if (address.network === 'tailscale') {
        return {
          title: slow ? `${where} did not answer in time` : `Can't reach ${where}`,
          message: 'Make sure Tailscale is connected on this phone and on your computer, and that Clawdling is running there.',
        };
      }
      if (address.network === 'lan') {
        return { title: slow ? `${where} did not answer in time` : `Can't reach ${where}`, message: LAN_HINT };
      }
      return {
        title: slow ? `${where} did not answer in time` : `Can't reach ${where}`,
        message: 'Check the address, and that Clawdling is running on your computer and reachable from this network.',
      };
    }
    if (e.kind === 'bad_response' || e.kind === 'not_found' || e.kind === 'unsupported') {
      return { title: "That isn't a Clawdling server", message: `${where} answered, but not like Clawdling does. Check the address in the link.` };
    }
    if (e.kind === 'forbidden') {
      return {
        title: 'Your computer refused the connection',
        message: `${e.serverMessage ? `It said: "${e.serverMessage}". ` : ''}If you reach it by a name or address it does not expect, add that to CLAWDLING_ALLOWED_HOSTS on your computer.`,
      };
    }
    return { title: 'Could not connect', message: e.message };
  }

  // step === 'me': the server is there, the code is the problem.
  if (e.kind === 'auth') {
    return {
      title: 'That pairing code was not accepted',
      message: 'Get a fresh code from the cockpit on your computer: Settings, then Connect your phone.',
    };
  }
  if (e.kind === 'forbidden') {
    return { title: 'Your computer refused the connection', message: e.serverMessage ? `It said: "${e.serverMessage}".` : e.message };
  }
  if (e.kind === 'unsupported') {
    return { title: 'Update Clawdling on your computer', message: 'This server is older than the app. Update Clawdling, restart it, then scan again.' };
  }
  if (e.kind === 'network' || e.kind === 'timeout') {
    return { title: `Lost ${where} while connecting`, message: 'Try again in a moment.' };
  }
  return { title: 'Could not connect', message: e.message };
}
