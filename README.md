# SplitIt — restaurant bill splitter

A phone web app (PWA) you add to your iPhone home screen. It opens full-screen like a normal app.

## What it does
1. **Items**: scan the bill with the camera (on-device text recognition with Tesseract.js) or type items in. Fix any misread lines. It warns you if the items don't add up to the TOTAL on the slip.
2. **People**: tap saved friends, type someone in, or import them from Contacts. In Contacts, open the person, tap Share Contact, then Save to Files, then use "Import a shared contact card". If Safari's Contact Picker is switched on, "Choose from contacts" also appears.
3. **Invite**: send each friend their own link by WhatsApp, SMS or any other app, or one link to a group chat. Each friend opens it on their own phone (no install needed) and ticks what they had. Shared items are split equally.
4. **Pay**: everyone pays the restaurant for their own share. Each friend sees exactly what to pay the waiter, and how to split it into amount plus tip if the card machine asks. They tap "I've paid". Your Pay screen has a **Show the waiter** list with everyone's amount and updates live: not opened / picking / ready to pay / paid.

Tick "Service charge is already on the bill" to drop the tip to 0%.

## Turn on sharing (one-off, about 10 minutes)
Friends' phones need a shared online database. This app uses Google Firebase Realtime Database on the free plan.
1. Go to https://console.firebase.google.com and add a project (you can turn Google Analytics off).
2. Open **Realtime Database** and click **Create database**. Pick a location and start in **locked mode**.
3. Open the **Rules** tab, replace everything with the contents of `database.rules.json`, and click **Publish**.
4. Copy the database URL shown on the **Data** tab (it looks like `https://<project>-default-rtdb.<region>.firebasedatabase.app`) and put it in `config.js`.

Until `config.js` has a URL, the app works in pass-the-phone mode.

### What goes online
- **Stored online:** the restaurant name, items and prices, first names, who ticked what, paid status and your name.
- **Stays on your phone:** phone numbers and your friends list.
- Anyone who has a bill's link can see and edit that bill. Links are long random codes and bills can't be listed.
- Use **Stop sharing** on the Pay screen to delete a bill's online copy.

## Put it on your iPhone
It has to be served over HTTPS. The simplest way is GitHub Pages:
1. GitHub → this repo → Settings → Pages → Source: *Deploy from a branch* → pick this branch, folder `/ (root)` → Save.
2. Open the Pages URL in **Safari** on the iPhone → Share → **Add to Home Screen**.

## Develop
- `python3 -m http.server` then open http://localhost:8000
- `npm test` runs the split and receipt-parsing tests (Node 18+, no dependencies).
- `node test/mock-firebase.mjs 9000` runs a local stand-in for Firebase. Point `config.js` at `http://localhost:9000` to try sharing without an account.
