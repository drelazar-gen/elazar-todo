# Elazar To-Do List (Web App)

A small, password-protected, mobile-friendly to-do list that reads and writes directly
to your Airtable "Items" table (base `apptn2yEy7TRhdkNm`, table `tbl5YWY1ZJkyQFqwA`) —
the same table your WhatsApp/Google Messages heartbeat chains write to.

## Deploy (Vercel dashboard, no terminal needed)

1. Create a new **empty** repository on GitHub (e.g. `elazar-todo-app`).
2. Upload every file in this folder to that repo (GitHub's "Add file → Upload files"
   page accepts drag-and-drop of the whole folder in Chrome/Edge).
3. Go to vercel.com → **Add New → Project** → import that GitHub repo.
4. Before the first deploy, expand **Environment Variables** and add:
   - `AIRTABLE_TOKEN` — your Airtable personal access token, scoped to just this base,
     with `data.records:read` and `data.records:write` scopes.
   - `PAGE_PASSWORD` — the password you want to use to unlock the page.
   - `SESSION_SECRET` — any long random string (used to sign login sessions).
5. Click **Deploy**. Vercel gives you a `https://your-project.vercel.app` URL — that's
   your page, works on any phone or computer, and asks for the password on first visit.

No build step, no framework, no dependencies — this is plain HTML/CSS/JS plus three
small serverless functions in `/api`.
