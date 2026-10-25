# Core user stories

The stories every cockpit built on the Clawdling core should pass: sessions, chat, status, chips,
voice and import. They are written for the person at the screen, in plain words, and each has an
id (CS-NN) that the end-to-end tests carry in their titles (`npx playwright test -g CS-14`).
[PARITY.md](PARITY.md) tracks which features are in the core; [USER-STORIES.md](USER-STORIES.md)
is the longer list with priorities and acceptance notes.

## Sessions

- **CS-01 Start a session.** I start a new session with an agent from the rail (or the org map),
  and it opens focused in the workspace, in that agent's folder, ready for my first message.
  Test: `cockpit.spec.js` "CS-01: new session from the rail opens focused in the workspace".
- **CS-02 Resume a session.** An ended session is in Recent; one click resumes the same
  conversation (`claude --resume`) and focuses it. Test: `cockpit.spec.js` "CS-02".
- **CS-03 End a session safely.** Ending a session asks first (Cancel is the default), and hiding
  a pane never stops its session. Test: `cockpit.spec.js` "CS-03".
- **CS-04 Rename a session.** I rename a session by double-clicking its title; the name shows on
  the rail and the pane. Test: `cockpit.spec.js` "CS-04".
- **CS-05 Many panes.** I keep several sessions on screen (Focus, Split, Grid), and a key focuses
  pane N without dropping any. Test: `cockpit.spec.js` "CS-05".
- **CS-06 A rail of real names.** The rail lists every session by its real name, grouped as Needs
  you, Live and Recent, and collapses into a strip. Test: `cockpit.spec.js` "CS-06".
- **CS-07 Sessions and restarts.** With tmux, sessions keep running when the cockpit stops and
  come back attached. With the built-in terminal they end with the cockpit and resume in one
  click, and if its terminal process ever stops on its own, the cockpit keeps running and says so
  on each session it ended. Tests: `test/integration/restart.test.js`,
  `test/integration/pty-host.test.js`.

## Chat

- **CS-08 A clean chat view.** A session opens in a chat view read from Claude Code's own
  transcript: messages, safe Markdown (code, tables, links), no raw HTML. Test: `chat.spec.js` "CS-08".
- **CS-09 Tool calls fold away.** Each tool call is one line that expands to its detail.
  Test: `chat.spec.js` "CS-09".
- **CS-10 Send from the chat.** I type in the composer, Enter sends, and the reply appears without
  a reload. Test: `chat.spec.js` "CS-10".
- **CS-11 Raw is one click away.** Raw shows the real terminal; the choice is remembered per pane.
  Test: `chat.spec.js` "CS-11".
- **CS-12 Chat on a phone.** On a phone the chat fits, the field is 16 px (no zoom), targets are
  44 px, nothing scrolls sideways. Test: `chat.spec.js` "CS-12".

## Status and attention

- **CS-13 Status I can trust.** New, Working, Your turn, Needs you and Ended come from Claude
  Code's own hooks and reach the rail live. Test: `cockpit.spec.js` "CS-13".
- **CS-14 Answer a question in the chat.** When Claude asks me something (AskUserQuestion), I see
  the question and its options as a card; I pick one, or type my own answer, and Send. The card
  keeps what I answered, and it works on my phone. Tests: `cards.spec.js` "CS-14",
  `test/integration/questions.test.js`, `test/live/questions-live.mjs` (real Claude Code).
- **CS-15 Several questions at once.** Several questions, including pick-any-that-apply ones, go
  in one Send. Test: `cards.spec.js` "CS-15".
- **CS-16 Approve a plan.** When Claude has a plan, I read it in a card and approve it with Claude
  Code's own choices, or send it back with what to change. Test: `cards.spec.js` "CS-16".
- **CS-17 Permission prompts.** A permission prompt is answered with one click, its choices in
  the order Claude Code shows them. The web never approves anything Claude Code did not ask.
  Test: `firstrun.spec.js` "CS-17".
- **CS-18 Trust a folder.** The folder-trust question is answered with a button; "No, exit" ends
  the session and offers Resume. Test: `cockpit.spec.js` "CS-18".
- **CS-19 Watching.** When Claude's turn is over but background work it started is still running
  (watchers, background commands, agents, workflows), the session reads "Watching · N" on the pane,
  the rail and the phone, and a popover lists what, why and since when. Test: `cards.spec.js` "CS-19".
- **CS-20 Needs you comes first.** A session that needs me says so even while it watches; Ready
  means nothing is running in the background; Watching never counts as needing me.
  Test: `cards.spec.js` "CS-20".
- **CS-21 A notification when I am elsewhere.** With it turned on, my browser shows a
  notification when a session starts waiting on me and the cockpit tab is in the background. It
  names the agent and the kind of wait, never what was asked. Test: `cards.spec.js` "CS-21".
- **CS-22 A message when I am away.** Turned on (it is off by default), one line goes to the chat
  I paired with my chief of staff: which agent needs me and what kind of wait, never the question.
  It goes only to that chat, at most once per session every 10 minutes.
  Test: `test/integration/needs-you.test.js`.
- **CS-23 Not signed in.** A session that is not signed in to Claude says so, and one click starts
  the sign-in; Start again picks it up. Test: `firstrun.spec.js` "CS-23".
- **CS-24 One honest count.** "Need you" is one number everywhere: Claude asked, or a finished
  turn waits for me. Test: `org.spec.js` "CS-24".

## Chips and voice

- **CS-25 Model and effort.** The pane's chips show its model and effort, and switch them between
  turns. Test: `chips.spec.js` "CS-25".
- **CS-26 Dictation.** The mic fills the composer with what I say and never sends by itself.
  Test: `chips.spec.js` "CS-26".

## Org, memory and import

- **CS-27 Bring in my projects.** The cockpit finds the projects already on my computer (and on
  GitHub) and makes them project agents with drafted context, several at once.
  Test: `import.spec.js` "CS-27".
- **CS-28 See my Claude Code setup.** Settings lists my skills, agents and commands by name only,
  never a value. Test: `import.spec.js` "CS-28".
- **CS-29 Agent memory.** Each agent's page edits its CLAUDE.md and its memory (NOW.md), which the
  next session starts with. Test: `org.spec.js` "CS-29".
- **CS-30 My chief of staff by text.** I pair Telegram (or iMessage) with my chief of staff with a
  one-time code; only that chat reaches it. Tests: `org.spec.js` "CS-30",
  `test/integration/donna-telegram.test.js`.
