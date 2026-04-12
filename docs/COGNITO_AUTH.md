# Cognito sign-in (Auth.js / NextAuth v5)

Human login uses AWS Cognito with the built-in OIDC provider in `src/auth.ts`. The OAuth **redirect URI** Auth.js sends to Cognito is:

`{origin}/api/auth/callback/cognito`

where `{origin}` must match how you open the app in the browser.

## Local development (`localhost`)

1. **`AUTH_URL` (or legacy `NEXTAUTH_URL`)**  
   - **Recommended for local:** **unset** `AUTH_URL` so Auth.js uses the request `Host` (`trustHost: true` is already set).  
   - **Or** set it to the exact origin you use, e.g. `http://localhost:3000` (same port as `npm run dev`).  
   - If `AUTH_URL` is your **production** URL while you test on `localhost`, Cognito will see a **redirect_uri** for production, which will not match your localhost app callback → **`OAuthCallbackError`**.

2. **Cognito app client — Allowed callback URLs**  
   Include every origin you use, e.g.:

   - `http://localhost:3000/api/auth/callback/cognito`
   - `http://localhost:3001/api/auth/callback/cognito` (if you sometimes run another port)

3. **Cognito app client — Allowed sign-out URLs** (if you configure sign-out redirects)  
   Add the same origins as needed, e.g. `http://localhost:3000/`.

4. **`AUTH_COGNITO_ISSUER`**  
   Format: `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` — **no trailing slash** (the app strips trailing slashes, but keep the pool id correct).

5. **OAuth scopes**  
   The app requests `openid email profile`. Ensure the app client allows the hosted UI / OIDC flow your pool uses.

## After an error

Sign-in errors redirect to `/login` with `?error=...`. Use **Continue with Cognito** again after fixing env or Cognito settings. See also [errors.authjs.dev#oauthcallbackerror](https://errors.authjs.dev#oauthcallbackerror).

## `error=Configuration` (or HTTP 500 on `/api/auth/error`)

Auth.js uses this when server config is invalid **or** when an internal error is hidden as `Configuration`.

1. **`AUTH_SECRET`** — Required. Generate and add to `.env.local`, then restart the dev server:

   ```bash
   npx auth secret
   ```

   An empty `AUTH_SECRET=` line is treated as missing.

2. **Port mismatch** — If you run on **`:3001`**, either set `AUTH_URL=http://localhost:3001` or leave `AUTH_URL` unset. Do not set `AUTH_URL` to `:3000` while browsing `:3001`.

3. **Server logs** — With `NODE_ENV=development`, Auth.js prints `[auth][debug]` / `[auth][error]` lines in the terminal where `npm run dev` runs; check the **cause** right after a failed login.
