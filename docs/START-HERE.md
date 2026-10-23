# Start here: Clawdling for people who have never used a terminal

This page is for you if you use Claude in the **desktop app** or in your **web browser**, you are
not a programmer, and someone sent you a link to Clawdling. No prior knowledge needed.

## What Clawdling is, in plain words

Clawdling turns Claude into a small team that works for you. You get a "chief of staff" called
Donna, one assistant for each area of your life or work (for example Work, Health, Money, Home)
and one for each project. Each assistant remembers what it is doing between conversations. You see
the whole team on one page in your web browser, called the **cockpit**, and you talk to any of them
there.

Clawdling is free. It runs on your own computer and uses the Claude plan you already pay for.

## What you need

| You need | Why | How to check |
|---|---|---|
| A **Mac, Windows PC or Linux computer** | Clawdling runs on your computer. A phone, an iPad or a Chromebook cannot run it. | |
| A **paid Claude plan**: Pro, Max, Team or Enterprise | Clawdling runs on **Claude Code**, and the free Claude plan does not include Claude Code. | claude.ai, then Settings, then Billing |
| **Claude Code** | Claude Code is the version of Claude that can work on your computer: it can open files and run programs when you allow it. Clawdling's assistants are Claude Code sessions. | See step 1 |
| About 15 minutes | Most of it is Claude installing things for you. | |

**On a work laptop?** Nothing here needs an administrator password, but some companies block
installing software or running Claude Code on their laptops. If yours does, ask IT first.

**About the Pro plan.** Pro works. Its usage allowance is smaller than Max's, and every assistant
you talk to draws from that one allowance. Talk to one or two
assistants at a time. When you hit the limit, Claude Code tells you when it resets, and the
assistants simply wait until then. Clawdling adds no limits and no fees of its own. Max gives 5x
or 20x Pro's usage if you end up using it all day.

## Step 1: get Claude Code

Pick the line that describes you.

**"I use the Claude desktop app."** Good: the app already has Claude Code inside it.
1. Open the Claude app and sign in.
2. Click the **Code** tab at the top of the sidebar. If it asks you to upgrade, your plan does not
   include Claude Code yet (see the table above).
3. Under the message box, choose **Local**, then choose a folder. Your Documents folder is fine.
   Clawdling does not put anything in it.

Anthropic's guide, with pictures: [Get started with the desktop app](https://code.claude.com/docs/en/desktop-quickstart).

**"I only use Claude in my web browser (claude.ai)" or on my phone.** Chat cannot install
software on your computer. If you paste the setup line into a chat, Claude can only explain it to
you. To use Clawdling:
1. Download the Claude desktop app for your computer from [claude.com/download](https://claude.com/download)
   and sign in with the same account you use on claude.ai.
2. Follow "I use the Claude desktop app" just above.

**"I'm fine with a terminal."** Install Claude Code with Anthropic's official installer
([setup guide](https://code.claude.com/docs/en/setup); never a copy from anywhere else), then
start `claude` and sign in:
- Mac and Linux: `curl -fsSL https://claude.ai/install.sh | bash`
- Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`

New to terminals? Anthropic's [terminal guide](https://code.claude.com/docs/en/terminal-guide)
shows how to open one and paste a command.

## Step 2: paste one line

In Claude Code (the desktop app's Code tab, or `claude` in a terminal), paste this and press Enter:

```
Set up Clawdling for me from https://github.com/jddavenportOpen/clawdling and follow SETUP.md
```

What happens next, so nothing surprises you:

1. **Claude checks your computer** and tells you in one line what it found.
2. **It tells you what is missing and asks before installing anything.** On a new Mac that is
   usually two things:
   - **Node.js**, a free program Clawdling runs on;
   - **the `claude` command**: if you use the desktop app, Clawdling needs this one extra piece of
     Claude Code to start your assistants. Claude installs it with Anthropic's official installer,
     which needs no password.

   Say yes to each, or ask "what is that?" first. Claude does not need your computer's
   administrator password for any of it. If a window ever asks for that password, Claude should
   have told you why first; you can say no and ask for the way that does not need it.
3. **Claude Code asks permission before it runs commands.** That is Claude Code being careful, not
   Clawdling. Choose "Yes" for the setup steps you just agreed to.
4. **Sign in, once.** If the new `claude` command is not signed in yet, your browser opens a Claude
   sign-in page. Sign in with the same account you use in the app.
5. **Up to five questions** about you and your areas. Choose **Use defaults** if you just want to
   try it; you can change everything later.
6. **The cockpit opens in your browser.** Bookmark it.

## Step 3: your first five minutes in the cockpit

1. **Trust your org folder.** The cockpit shows a card, "First, trust your org folder". Click
   **Trust my org folder**. A session opens and Claude Code asks whether you trust the folder:
   click **Yes, trust it**. You do this once; after that no assistant asks again. (Closed it or
   reloaded the page? The question waits under **Needs you** at the top of the left list.) Do this
   before you start any assistant: one started earlier asks about its own folder too.
2. **Talk to an assistant.** Click one of the cards under "Then start a session with" (later:
   click an assistant in the left list, then **New session**). Type a question, like "What do you
   do for me? Answer in two lines."
3. **The chat view** is the clean view you see by default: your messages and its answers.
4. **The Raw view.** Each session has **Chat** and **Raw** buttons at its top. Raw shows the real
   Claude Code screen. Use it if the assistant seems stuck or asks something the chat view
   does not show.
5. **Add an assistant.** Click **New agent** (the person-with-a-plus icon at the top of the left
   list) and follow the steps.
6. **Donna**, your chief of staff, has her own page (Donna, at the bottom of the left list). From
   there you can connect her to Telegram so you can text her from your phone.

Every assistant is a normal Claude Code session. It asks before it edits your files or runs a
program, the same as Claude Code always does.

## What Clawdling does and does not do with your account

- It starts Claude Code on your computer for you, the same as if you typed `claude` yourself.
- It never sees, saves or sends your Claude password or login.
- It never talks to Anthropic directly and charges nothing. Your usage is your normal plan usage.
- Your assistants and their notes are plain files in a folder called `clawdling` in your home
  folder. Clawdling sends nothing anywhere; your assistants talk to Claude the same way Claude
  Code always does.
- Texting Donna from your phone (Telegram, or iMessage on a Mac) is optional and stays off until
  you set it up.
- Clawdling is a new open-source project, built by one person ([JD Davenport](https://jddavenport.com)),
  not by Anthropic. All of its code is public in this repository.

## When something goes wrong (plain-language fixes)

Tip: you can paste any of these questions into Claude Code (the Code tab) and it will fix them for
you.

- **"Claude says it can't run commands or install software."** You are in a regular chat
  (claude.ai, or the Chat tab), not Claude Code. Use the **Code** tab of the desktop app.
- **"The Code tab asks me to upgrade."** Your plan does not include Claude Code. Pro, Max, Team
  and Enterprise do; the free plan does not.
- **"It says `claude: command not found` or 'Clawdling can't find the claude command'."** The
  desktop app has Claude Code inside it but not this command. Tell Claude Code: "Install the
  claude command with Anthropic's official installer, then restart Clawdling."
- **"It says `node: command not found` or that Node.js is missing."** Tell Claude Code: "Install
  Node.js for Clawdling without needing my admin password."
- **"A window asks for my Mac password."** Something wants to install system-wide. You can say no.
  Clawdling never needs it; ask Claude Code for the no-password way.
- **"The cockpit page says the site can't be reached."** The cockpit is not running (for example
  after a restart). Tell Claude Code: "Start my Clawdling cockpit and open it." To have it start by
  itself when you log in, tell Claude Code: "Make Clawdling start automatically at login."
- **"An assistant says Claude Code isn't signed in yet."** The `claude` command Clawdling uses has
  its own sign-in. Click **Sign in** on that assistant's session: a new session opens and Claude
  Code takes you to a sign-in page in your browser. When it says you're signed in, click **Start
  again** on the first session. (Or tell Claude Code: "Sign in the claude command for Clawdling
  with `claude auth login`.")
- **"An assistant says I hit my usage limit."** That is your Claude plan's limit, not Clawdling.
  It says when it resets; the assistants wait until then. Fewer assistants at once uses it more
  slowly.
- **"An assistant asks whether I trust a folder."** Answer **Yes** for folders inside your
  `clawdling` folder, or for a project folder that is yours.
- **"An assistant seems stuck."** Click **Raw** at the top of its session to see the real screen.
  It is usually waiting for you to answer a question.
- **"I want to remove Clawdling."** Tell Claude Code: "Uninstall Clawdling: stop the cockpit, remove
  the login item if there is one, and delete ~/.clawdling-app." Your assistants' files stay in
  `~/clawdling` until you delete that folder yourself.

More: the [README](../README.md) and its Troubleshooting section, written for people who use a
terminal.
