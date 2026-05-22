# Setup Guide — Chandra Color Shoppee WhatsApp Bot

This guide takes you from zero to a working WhatsApp bot. No coding needed.
You only paste in values. Read each step fully before doing it.

Total time: about 30–45 minutes. Take it slow — each step is simple.

You will use three free/low-cost services:
- **Anthropic** — provides the AI brain (Claude). Pay-per-use, very cheap for a shop.
- **Render** — hosts the bot online for free.
- **Twilio** — connects the bot to WhatsApp. Free sandbox for testing.

------------------------------------------------------------
## WHAT YOU RECEIVED
------------------------------------------------------------
A folder called `ccs-bot` containing:
- `server.js` — the bot engine (do not edit)
- `botConfig.js` — your shop info, FAQ, trends (EDIT THIS to change replies)
- `package.json`, `.env.example`, `.gitignore` — supporting files
- `SETUP_GUIDE.md` — this file

------------------------------------------------------------
## STEP 1 — Get your Anthropic (Claude) API key
------------------------------------------------------------
1. Go to https://console.anthropic.com and sign up / log in.
2. Add a payment method under **Billing** (the bot costs roughly a few
   paise per customer message — typically well under Rs.100/month for a
   small shop. Set a low monthly limit like $5 to stay safe).
3. Go to **Settings → API Keys → Create Key**.
4. Copy the key (it starts with `sk-ant-`). Save it somewhere safe.
   You will paste it in Step 4.

------------------------------------------------------------
## STEP 2 — Put the code online with GitHub
------------------------------------------------------------
Render needs the code from a GitHub repository.
1. Go to https://github.com and create a free account.
2. Click **New repository**. Name it `ccs-bot`. Keep it **Private**.
   Click **Create repository**.
3. On the new repo page, click **uploading an existing file**.
4. Drag in ALL files from the `ccs-bot` folder
   (`server.js`, `botConfig.js`, `package.json`, `.env.example`,
   `.gitignore`, `SETUP_GUIDE.md`). Do NOT upload the `node_modules`
   folder if one exists.
5. Click **Commit changes**.

------------------------------------------------------------
## STEP 3 — Host the bot on Render
------------------------------------------------------------
1. Go to https://render.com and sign up with your GitHub account.
2. Click **New → Web Service**.
3. Connect and select your `ccs-bot` repository.
4. Fill in the settings:
   - **Name:** ccs-bot
   - **Region:** Singapore (closest to India)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Do NOT click Create yet — first do Step 4 below (environment variables).

------------------------------------------------------------
## STEP 4 — Add your API key to Render
------------------------------------------------------------
Still on the Render "New Web Service" page:
1. Scroll to **Environment Variables** and click **Add Environment Variable**.
2. Add this one:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** the `sk-ant-...` key you copied in Step 1
3. Now click **Create Web Service**. Render will build and start the bot.
4. When it shows **Live**, copy your bot's web address at the top.
   It looks like: `https://ccs-bot.onrender.com`
5. Open that address in a browser. You should see:
   "Chandra Color Shoppee WhatsApp bot is running." — that means it works.

Your webhook URL is that address with `/whatsapp` added, e.g.
`https://ccs-bot.onrender.com/whatsapp`  — you need this in Step 6.

------------------------------------------------------------
## STEP 5 — Set up Twilio WhatsApp (testing sandbox)
------------------------------------------------------------
1. Go to https://www.twilio.com and create a free account.
2. In the Twilio Console, go to:
   **Messaging → Try it out → Send a WhatsApp message**.
3. You'll see a Twilio sandbox number and a join code
   (like `join something-word`).
4. From your own WhatsApp, send that join code to the Twilio number shown.
   You'll get a "connected" confirmation. Now you can test the bot.

------------------------------------------------------------
## STEP 6 — Connect Twilio to your bot
------------------------------------------------------------
1. In the Twilio Console, go to:
   **Messaging → Settings → WhatsApp sandbox settings**.
2. Find the field **"When a message comes in"**.
3. Paste your webhook URL there:
   `https://ccs-bot.onrender.com/whatsapp`
   (use YOUR Render address from Step 4).
4. Make sure the method is set to **HTTP POST**.
5. Click **Save**.

------------------------------------------------------------
## STEP 7 — Test it
------------------------------------------------------------
From your WhatsApp, message the Twilio sandbox number:
- Send: "Hi"  → the bot should greet you.
- Send: "What brands do you have?"
- Send: "Suggest a colour for my bedroom"
- Send: "What is the colour of the year 2026?"

If it replies, your bot works! 🎉
(The free Render plan sleeps when idle, so the FIRST message after a quiet
period may take ~30–50 seconds. Replies are fast after that.)

------------------------------------------------------------
## STEP 8 — Going live for real customers (later)
------------------------------------------------------------
The sandbox is for testing only — customers must send a join code first.
To use your own shop WhatsApp number with no join code:
1. In Twilio, go to **Messaging → Senders → WhatsApp senders**
   and request a **WhatsApp Business sender**.
2. Twilio will guide you through Meta's business verification
   (needs your shop/business details). This can take a few days.
3. Once approved, update the webhook URL the same way as Step 6.
This is optional and can be done whenever you're ready.

------------------------------------------------------------
## HOW TO UPDATE THE BOT LATER (offers, trends, timings)
------------------------------------------------------------
1. In your GitHub repo, open `botConfig.js` and click the pencil (Edit) icon.
2. Change the text — e.g. update the "WHAT'S NEW" section, shop timings,
   or delivery info. Edit text only; don't remove backticks or punctuation.
3. Click **Commit changes**.
4. Render automatically redeploys within a minute or two. Done.

Things to fill in soon (search for "[FILL IN" in botConfig.js):
- Shop timings (days and hours)
- Home delivery details
- The "Last updated" date and offers in the WHAT'S NEW section

------------------------------------------------------------
## COSTS SUMMARY
------------------------------------------------------------
- Render free plan: Rs.0 (bot sleeps when idle; fine for a shop).
- Twilio sandbox: Rs.0 for testing. A live WhatsApp sender has small
  per-conversation fees — check Twilio's India pricing.
- Anthropic: pay-per-use. Each customer chat costs a tiny amount.
  Set a spending limit in the Anthropic console to stay in control.

------------------------------------------------------------
## IF SOMETHING DOESN'T WORK
------------------------------------------------------------
- Bot says "assistant is busy": usually the API key is wrong or billing
  isn't set up. Re-check Step 1 and Step 4.
- No reply at all: re-check the webhook URL in Step 6 — it must end in
  `/whatsapp` and method must be POST.
- First reply very slow: normal on Render's free plan after idle time.
- Check Render's **Logs** tab — it shows errors in plain text.

For help, the shop team can contact a developer with this guide — every
step and file name is named here, so it's quick for anyone technical.
