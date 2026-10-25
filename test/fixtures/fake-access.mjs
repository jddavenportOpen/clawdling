// A fake Cloudflare Access team for the Use from anywhere tests: an RSA key, its JWKS (what
// <team>/cdn-cgi/access/certs serves) and Cf-Access-Jwt-Assertion tokens signed with it.
import crypto from 'node:crypto';

export function fakeAccess({ team = 'https://team.cloudflareaccess.com', aud = 'f'.repeat(64) } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const sign = (claims, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) => {
    const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ aud: [aud], iss: team, email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), ...claims })).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  return { team, aud, certs: { keys: [jwk] }, sign };
}
