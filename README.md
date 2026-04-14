# Cashfree Payment Server

Deploy this on **Render** (free tier works fine). Switch between TEST and PROD by changing **one environment variable** — no rebuild, no redeploy.

---

## 1. Deploy to Render

1. Push this `server/` folder to a GitHub repo (can be a separate repo or a subfolder).
2. Go to [render.com](https://render.com) → **New → Web Service**.
3. Connect your GitHub repo.
4. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: `Node`

---

## 2. Set Environment Variables in Render

Go to your Web Service → **Environment** tab and add:

| Key | Value |
|-----|-------|
| `CASHFREE_APP_ID` | Your Cashfree App ID (from Cashfree Dashboard → Developers → API Keys) |
| `CASHFREE_SECRET_KEY` | Your Cashfree Secret Key |
| `CASHFREE_ENV` | `TEST` for sandbox, `PROD` for live — **change this alone to go live** |
| `FIREBASE_PROJECT_ID` | Your Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | From Firebase service account JSON |
| `FIREBASE_PRIVATE_KEY` | From Firebase service account JSON — paste the full key including `-----BEGIN...-----END-----` |
| `ADMIN_API_KEY` | A strong random secret string you choose (e.g. `sk_admin_abc123xyz`) |

### Getting Firebase service account credentials
1. Firebase Console → Project Settings → **Service accounts**
2. Click **Generate new private key** → download JSON
3. Copy `project_id`, `client_email`, and `private_key` from the JSON

---

## 3. After Deploy

Copy your Render URL (e.g. `https://your-app.onrender.com`) and:

- **Flutter**: Set `vercel_api_url` in Firestore `pricing_config/plans` to `https://your-app.onrender.com/create-order`
  (Your MERN app can do this via the `/update-pricing` endpoint below)
- **Health check**: Visit `https://your-app.onrender.com/health` — should return `{"status":"ok",...}`

---

## 4. Go Live (TEST → PROD)

1. In Render → Environment, change `CASHFREE_ENV` from `TEST` to `PROD`
2. Change `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` to your **production** Cashfree keys
3. Click **Save Changes** — Render restarts the server automatically
4. **The Flutter app does not need to be rebuilt or updated**

---

## 5. MERN Admin Panel Integration

Call `POST /update-pricing` from your MERN **backend** (never from the frontend — that would expose your ADMIN_API_KEY):

```javascript
// In your MERN Express route (server-side)
const updatePricing = async (req, res) => {
  const response = await fetch('https://your-app.onrender.com/update-pricing', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CASHFREE_SERVER_ADMIN_KEY}`, // same as ADMIN_API_KEY
    },
    body: JSON.stringify({
      standard_monthly: 999,
      standard_annual:  799,
      premium_monthly:  1999,
      premium_annual:   1599,
      updatedBy: req.user.email,   // from your MERN auth middleware
    }),
  });
  const data = await response.json();
  res.json(data);
};
```

Store `ADMIN_API_KEY` in your MERN app's `.env` as `CASHFREE_SERVER_ADMIN_KEY` (or any name). **Never expose it to the browser.**

Flutter listens on a Firestore real-time stream — prices update in the app within ~1 second of calling this endpoint.

---

## 6. Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/create-order` | None | Flutter calls this to create a Cashfree order |
| `POST` | `/verify-payment` | None | Verify payment status (also use as Cashfree webhook URL) |
| `POST` | `/update-pricing` | `Bearer ADMIN_API_KEY` | Update plan prices from MERN admin |
| `GET` | `/health` | None | Render health check |

---

## 7. Flutter `.env` changes needed

After deploying, update your Flutter `.env`:

```
# The Render server URL is stored in Firestore, not in .env
# Just make sure these are correct:
CASHFREE_ENV=TEST         # Keep TEST in Flutter — the server controls the real mode
```

The `vercel_api_url` field in Firestore `pricing_config/plans` should point to:
`https://your-app.onrender.com/create-order`
