// Which on-screen choice of a Claude Code startup dialog means "yes" and which means "no".
//
// Claude Code decides the order, and it has changed: 2.1.283's folder-trust dialog lists
// "No, exit" first. So the buttons follow the server's `choices` (read off the real screen, in
// screen order) and match them by label, never by a hard-coded number. Null when the choices are
// missing or unrecognised: the caller then shows no buttons rather than guess, because a wrong
// guess on the trust dialog exits the session.
export function dialogAnswers(choices) {
  if (!Array.isArray(choices)) return null;
  const label = (c) => String((c && c.label) || '').replace(/^\s*\d+[.)]\s*/, '');
  const pick = (re) => choices.find((c) => c && Number.isInteger(c.option) && re.test(label(c)));
  const yes = pick(/^(yes|allow)\b/i);
  const no = pick(/^(no|don[’']?t)\b/i);
  if (!yes || !no || yes.option === no.option) return null;
  return { yes: yes.option, no: no.option };
}
