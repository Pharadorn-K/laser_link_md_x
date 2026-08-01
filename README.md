# new-laser-marking

Single-page app for controlling the KEYENCE MD-X2520A laser marker.

```
new-laser-marking/
├── .vscode/
│   └── settings.json
├── backend/
│   ├── node/
│   │   ├── .env
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── server.js
│   │   ├── config/
│   │   │	 └── db.js
│   │   ├── controllers/
│   │   │	 └── auth.controller.js
│   │   ├── db/
│   │   │	 └── schema.sql
│   │   ├── middleware/
│   │   │	 └── requireRole.js
│   │   ├── routes/
│   │   │	 ├── auth.routes.js
│   │   │	 ├── equipment.routes.js
│   │   │	 └── users.routes.js
│   │   ├── services/
│   │   │	 └── laserService.js
│   │   └── uploads/
│   │    	 └── photo/
│   └── python/
│       ├── laser_core.py
│       ├── laser_marker_service.py
│       └── requirements.txt
├── frontend/
│   ├── login.html              sign in / sign up (tabbed)
│   ├── index.html              SPA shell: side bar + top bar + #content
│   ├── css/
│   │   ├── base.css
│   │   ├── login.css
│   │   └── dashboard.css
│   ├── js/
│   │   ├── login.js
│   │   └── dashboard.js
│   └── pages/                  fragments injected into #content by dashboard.js
│       ├── home.html
│       ├── model_set.html
│       ├── manual.html
│       ├── alarm_center.html
│       ├── profile.html
│       ├── user.html					# requireAuth : admin
│       └── equipments.html				# requireAuth : admin
├── test/
├── .gitignore
└── README.md
```

## 1. Database

```bash
mysql -u root -p < backend/node/db/schema.sql
```

This creates the `new_laser_marking` database, the `users` table, and a
bootstrap admin account:

- Employee ID: `admin`
- Password: `Admin@123`

**Change this password immediately** (Profile page, once signed in).

## 2. Python equipment service

```bash
cd backend/python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python laser_marker_service.py       # listens on :5000
```

## 3. Node API gateway (also serves the frontend)

```bash
cd backend/node
cp .env.example .env   # if you renamed it; otherwise edit .env directly
npm install
npm run dev             # nodemon, or `npm start`
```

Edit `backend/node/.env` with your real MySQL credentials, a proper
`JWT_SECRET`, and the Python service URL if it isn't on `localhost:5000`.

## 4. Open the app

Visit `http://localhost:4000` — you'll land on the sign-in page.
Sign up for a new account, then have an admin (e.g. the bootstrap
`admin` account) approve it from the **Users** page before you can
sign in.

## Notes

- **Equipment** and **Users** pages are admin-only (checked both in the
  UI and on every Node API route via `requireRole('admin')`).
- The command browser on the Equipment page is generated entirely from
  `COMMAND_GROUPS` in `backend/python/laser_core.py` — the same data
  structure from the original `laser_v2_all_command.py`, just served
  over `/api/equipment/commands` instead of being read by Tkinter.
- `home.html`, `model_set.html`, `manual.html`, and `alarm_center.html`
  are intentionally empty placeholders for future development.
- CSS/JS files are sectioned with `FOR <PAGE NAME>` comments so future
  pages can be added without hunting through unrelated styles/logic.
