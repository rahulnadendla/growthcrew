# GrowthCrew — an AI growth team for every startup

Paste a product page link. A team of 5 AI agents researches the market, writes ads in English, Hindi and Telugu, plans a fair 7-day test, then reads the results, writes down what it learned and builds the next round of ads from those learnings.

**What's real:** every agent's output, the web research, and the decisions after each round. These are live calls to Claude.
**What's mocked:** the ad performance numbers (spend, clicks, signups) are sample data. No ads are posted.

## The team

| Agent | Job |
|---|---|
| 🔎 Researcher | Reads the product page, searches the web for 3 competitors and customer pains, proposes 5 positioning angles. Each angle must be backed by a claim on the page. |
| ✅ Reviewer | Checks the research, then checks every ad: claims must come from the page, Hindi and Telugu in the right script, no word-for-word translation, word limits. Sends bad ads back. |
| 🧭 Head of Growth | Picks 3 test cells (angle + language + audience), signs off the test plan (metric, winner rule, stop rule), reads results, decides scale / keep / stop, writes learnings, plans the next round. |
| ✍️ Copywriter | Writes 15 ads (5 angles × 3 languages), fixes the ones sent back, writes next-round ads from the learnings. |
| 📣 Channel Lead | Picks channel, format, targeting and daily budget for each test. |

## How it works (simple version)

- The browser runs the agents one after another, so each step is short.
- Each step is a separate Claude call with its own role and instructions (`lib/agents.ts`).
- Every agent must reply in a fixed format. The server checks the reply in code (for example, exactly 5 angles, headline 8 words or fewer). If it's wrong, the agent gets one more try with the exact problems listed.
- The learning loop: sample results are generated (`lib/simulate.ts`), the Head of Growth reads them, and the learnings log grows each round. The next round's ads are written from it.

## Safety built in

- The API key lives only in an environment variable. It is never in the code. `.env.local` is in `.gitignore`.
- Per-IP rate limits on both API routes. Input size caps. Requests from other websites are blocked.
- The page fetcher only opens public http/https pages. It blocks localhost and private networks, has an 8-second timeout and a 2MB cap.
- Agents are told that page text is data, never instructions (protects against prompt injection).
- Unknown agent names are rejected.
- **Also set a monthly spend limit in the Claude Console** (about $10). This is the hard cap.

## Run it on your laptop

1. Unzip, then open the folder in Cursor (File → Open Folder).
2. Copy `.env.example` to a new file named `.env.local`, and put your Claude API key in it.
3. In Cursor's terminal (View → Terminal):
   ```
   npm install
   npm run dev
   ```
4. Open http://localhost:3000

## Put it online

1. Push to GitHub. In the terminal:
   ```
   git init
   git config user.name "Your Name"
   git config user.email "your-personal@email.com"
   git add .
   git commit -m "GrowthCrew"
   ```
   Then create an empty repo on github.com and run the two lines GitHub shows under "push an existing repository".
2. Vercel → Add New → Project → import the repo.
3. Before clicking Deploy, open **Environment Variables** and add `ANTHROPIC_API_KEY` = your key.
4. Deploy. You get a public link with no login needed.

## Built with

Claude Sonnet 5.5 via the Anthropic API (with Claude's web search tool), Next.js, Vercel. Code written with help from Claude and Cursor.
