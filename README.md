# SplitIt — restaurant bill splitter

A phone web app (PWA) you add to your iPhone home screen. It opens full-screen like a normal app.

## What it does
1. **Items**: scan the bill with the camera (on-device text recognition with Tesseract.js) or type items in. Fix any misread lines. It warns you if the items don't add up to the TOTAL on the slip. "2× Castle Lite" lines can be split into single items.
2. **People**: tap saved friends (name and mobile number) or add someone new.
3. **Who had what**: pass the phone round. Each person taps their name, then their items. A shared item is split equally between everyone who taps it.
4. **Tip & pay**: everyone tips a fixed 10% on their own food. Tick "service charge already on the bill" to drop the tip to 0%. Send each person their breakdown by WhatsApp or SMS, with your payment details added, then mark them paid.

All data stays on the phone (localStorage). Nothing is sent anywhere unless you tap WhatsApp or SMS.

## Put it on your iPhone
It has to be served over HTTPS. The simplest way is GitHub Pages:
1. GitHub → this repo → Settings → Pages → Source: *Deploy from a branch* → pick this branch, folder `/ (root)` → Save.
2. Open the Pages URL in **Safari** on the iPhone → Share → **Add to Home Screen**.

## Develop
- `python3 -m http.server` then open http://localhost:8000
- `npm test` runs the split and receipt-parsing tests (Node 18+, no dependencies).
