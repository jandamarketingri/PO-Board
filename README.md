# Printer PO Board

A shared board of open purchase orders to the shirt printers: one row per vendor, one card per PO, with notes, ETAs, stars and tracking steps. It replaces the Microsoft Whiteboard.

- **Website:** GitHub Pages (free) serves the page.
- **Data and logins:** Firebase (Google, free tier) stores the POs, notes and ETAs and handles sign-in.
- **Imports:** either drag the MAS export onto the page, or let `tools/import.js` push it automatically on a schedule.

```
index.html          the board
import-core.js      how a MAS export is read (shared by the page and the auto-import)
firebase-config.js  your Firebase project settings (step 5)
firestore.rules     who is allowed in (step 3)
tools/import.js     auto-import script (steps 6-8)
```

Setup takes about 30 minutes. You need a Google account for Firebase and a GitHub account.

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Create a project**. Name it something like `po-board`. Google Analytics isn't needed.
2. Stay on the free **Spark** plan. A board this size uses a tiny fraction of the free limits.

## 2. Turn on the database

1. In the left menu: **Databases & Storage > Firestore > Create database**. (Or type "Firestore" into **Search for products**.)
2. Choose a US location (e.g. `nam5` or `us-east1`). You can't change it later.
3. Start in **production mode**.

## 3. Set who can get in

1. Open **Firestore**, then the **Rules** tab.
2. Replace everything there with the contents of `firestore.rules`.
3. Edit the email list to the people who should use the board (lowercase), then click **Publish**.

To add someone later: add their email to this list and publish again, then create their login (step 4).

## 4. Turn on sign-in and create logins

1. In the left menu: **Security > Authentication** (or search "Authentication"). Click **Get started**, then enable **Email/Password**.
2. The tabs across the top of the Authentication page: **Users** > **Add user** for each person, with a temporary password. They can use **Forgot password** on the board to set their own.
3. **Settings > User actions**: untick **Enable create (sign-up)**, so nobody can make their own account.
4. **Settings > Authorized domains**: add your GitHub Pages domain, e.g. `yourname.github.io`.

## 5. Connect the page to Firebase

1. Click the gear > **Project settings**. Under **Your apps**, click the web icon `</>` and register an app (no hosting needed).
2. Copy the `apiKey`, `authDomain`, `projectId` and `appId` values into `firebase-config.js`.

These values are meant to be public. What protects the data is sign-in plus the rules from step 3.

## 6. Publish on GitHub Pages

1. Create a new GitHub repository, e.g. `po-board`.
2. Upload everything in this folder **except** `tools/node_modules` and any `service-account.json`. The `.gitignore` already excludes them if you use git.
3. In the repo: **Settings > Pages**, set **Source: Deploy from a branch**, **Branch: main / (root)**, then Save.
4. After a minute the board is live at `https://yourname.github.io/po-board/`.

On a free GitHub plan the repository has to be public for Pages to work. Only the code is public. The PO data stays in Firebase behind sign-in.

At this point the board works: sign in and use **Import MAS export** to load the first file.

---

## Automatic imports (optional)

Run this on the PC or server where MAS saves its scheduled export.

### 7. One-time setup

1. Install **Node.js LTS** from <https://nodejs.org>.
2. Copy this project's `tools` folder **and** `import-core.js` to that machine, keeping the layout (for example `C:\po-board\import-core.js` and `C:\po-board\tools\import.js`).
3. In Firebase: **Project settings > Service accounts > Generate new private key**. Save the file as `C:\po-board\tools\service-account.json`.
   **Keep this file private.** It can read and write everything on the board. Never upload it to GitHub.
4. Open a Command Prompt in `C:\po-board\tools` and run:
   ```
   npm install
   ```
5. Do a trial run that writes nothing:
   ```
   node import.js "C:\MAS Exports\Whiteboard_Upload.xlsx" --dry-run
   ```
6. Run the first real import, which also loads your vendor names:
   ```
   node import.js "C:\MAS Exports\Whiteboard_Upload.xlsx" --vendors "C:\po-board\Vendors and Vendor Numbers.xlsx"
   ```

### 8. Schedule it

In **Task Scheduler**, choose **Create Basic Task**:

- **Trigger:** Daily (or however often MAS exports), set about 15 minutes after the MAS export runs.
- **Action:** Start a program
  - Program: `C:\Windows\System32\cmd.exe`
  - Arguments: `/c node import.js "C:\MAS Exports\Whiteboard_Upload.xlsx" >> import.log 2>&1`
  - Start in: `C:\po-board\tools`
- On the last screen, tick **Open the Properties dialog**, then choose **Run whether user is logged on or not**.

Each run adds new POs and updates changed ones. It never deletes anything and never touches notes, ETAs, stars or steps. The board shows "Last import" with the time and file. `import.log` records every run.

---

## How it behaves

- **PO numbers:** all-digit PO numbers lose their leading zeros (`0002075` becomes `2075`) in both import paths, so notes always stay on the right card.
- **Sheets:** every sheet in the export is read, e.g. **Tees POs** and **Other POs**. Columns are matched by header name, so the sheets can differ: Other POs has **ShipToName** (shown on the card and searchable) and no Print column, and uses **QuantityOrderedRevised** for the ordered quantity.
- **MAS order status (OrderStatus column):** new POs are added only when they're **A** (active). POs already on the board always take the latest quantities and status: **C** (completed) moves them to *Received*, **X** (cancelled) moves them to *Cancelled*. Completed or cancelled POs that were never on the board are skipped.
- **Status of active POs:** worked out from Quantity Ordered vs Quantity Received: *Not received*, *Partial* or *Received*. **Close out short** on a card treats a partial PO as done without changing MAS.
- **Aging:** cards turn amber and then red by days since the PO date. Change the thresholds in Settings (gear icon).
- **ETA:** set on a card's detail panel. It turns red once the date passes while the PO is still open.
- **Vendors and steps:** rename vendors, reorder or hide rows, and edit the tracking steps (Art, Seps, Samples, RFIDs, UPCs) in Settings.

## Changing the MAS export

The import matches columns by header name. If the query changes, add the new header spelling to `ALIASES` in `import-core.js`. With no header row, it falls back to columns A–K in this order: PO number, PO date, order status, vendor no., print code, item code, description, product line, qty ordered, qty received, qty backordered.
