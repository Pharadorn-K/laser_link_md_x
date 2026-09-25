# laser_link_md_x

Multi-pallet production management dashboard for a KEYENCE **MD-X2520A**
laser marking cell running on an IPC. Controls the marker itself
(TCP/IP) plus the surrounding automation (doors, pallet swap) via a
Modbus I/O module, and tracks production through Setting → Transfer →
Mass Production.

## Machine overview

```
IPC/
└── Modbus (ETH-MODBUS-IO16R)
    ├── Laser marker: KEYENCE MD-X2520A (TCP/IP)
    └── I/O: 2-hand start/stop buttons, light bulb, door & pallet cylinders
```

**Physical layout / interlocks:**

- **Side door** — mechanical, spring-return. The user opens it manually
  during Setting; a spring closes it again over time. and also have
  D4SL-N2FFA-D4 for safety side doors. it NC contact so ON = OPEN, OFF = CLOSED.
- **Middle door** — mechanical. Separates the **Machine Room** (where
  the laser fires) from the **Operator Room** (where parts are loaded
  and unloaded). Opens/closes as a side effect of the pallet-swap
  cylinder action — it isn't driven independently. This is the door
  that actually protects the operator from the beam.
- **Front door** — powered by an **IAI EleCylinder EC-R6H-250-3-WA**.
  Protects the user during a pallet change; closes before
  `CHANGE_PALLET` / `CALL_PALLET1` / `CALL_PALLET2` run, reopens after.
- **Pallet swap** — two **IAI EleCylinder EC-S7H-500-3-WA** units:
  **#2** drives Pallet 1, **#3** drives Pallet 2. These physically move
  whichever pallet needs to be in the Operator Room (load) or Machine
  Room (mark).

The function stubs for all of the above (`OPEN_FRONT_DOOR`,
`CLOSE_FRONT_DOOR`, `CHANGE_PALLET`, `CALL_PALLET1`, `CALL_PALLET2`,
`CAMERA_TRIGGER`, `START_MARKING`, the 2D-code read/grade steps, etc.)
live in `WM_FUNCTIONS` in `frontend/js/dashboard.js`, ready to be wired
to the real Modbus I/O once hardware is connected — only the body of
each `run()` needs to change; the verdict shape
(`{ ok, alarm?, message }`) that the sequence runners depend on stays
the same.

## Production flow

Three phases per (model, job_no, pallet):

1. **Setting** — Admin / Engineer / Machine Controller select a model,
   dial in conditions, and mark test parts (`type='setting'` in
   `production_log`). Ends when someone runs **Complete Setting** on
   the Monitor page, which records how many parts were used for
   setting (`production_count_reset.base_count`,
   `reset_reason='setting_complete'`) and resets the visible count for
   Mass Production.
2. **Transfer** — "Complete Setting" is the handoff. It's gated to Auto
   mode only, and the backend (`production.controller.js`) refuses any
   `type='mass'` log entry for a model/lot until Complete Setting has
   run at least once for that combination.
3. **Mass Production** — Operator role only. Also gated on a
   **Production Goal** being set for the (model, lot_no) — operators
   cannot start a run with no target defined. Goals are keyed by
   `(model, lot_no)` rather than per-pallet so **AUTO1-2** (two
   pallets running the same model on different job numbers) share one
   combined target automatically; each pallet's card still shows/edits
   its own progress independently.
4. A `production_log` row is written only **after Start Marking succeeds** in
   a cycle (auto or manual). A failure before marking (door, pallet, interlock,
   laser not ready) logs nothing; a 2D-code / grade failure after marking still
   logs the part, with `code2d_result = 'T'`.

## Project structure

```
laser_link_md_x/
├── .vscode/
│   └── settings.json
├── backend/
│   ├── node/
│   │   ├── .env
│   │   ├── package.json
│   │   ├── package-lock.json
│   │   ├── server.js
│   │   ├── config/
│   │   │   └── db.js
│   │   ├── controllers/
│   │   │   ├── auth.controller.js
│   │   │   ├── model.controller.js
│   │   │   ├── production.controller.js
│   │   │   ├── productionLog.controller.js
│   │   │   └── systemLog.controller.js
│   │   ├── db/
│   │   │   └── schema.sql
│   │   ├── middleware/
│   │   │   ├── equipmentCommandPolicy.js  # allowlist for POST /api/equipment/raw (non-admin/engineer roles)
│   │   │   ├── requireRole.js
│   │   │   ├── upload.js              # user signup/profile photos
│   │   │   └── uploadModelPhoto.js    # model part photos
│   │   ├── routes/
│   │   │   ├── auth.routes.js
│   │   │   ├── equipment.routes.js
│   │   │   ├── io.routes.js           # proxy to the Python Modbus I/O bridge
│   │   │   ├── model.routes.js
│   │   │   ├── production.routes.js
│   │   │   ├── productionLog.routes.js
│   │   │   ├── systemLog.routes.js
│   │   │   └── users.routes.js
│   │   ├── services/
│   │   │   ├── ioService.js           # HTTP bridge to io_service.py
│   │   │   ├── laserService.js        # HTTP bridge to the Python service
│   │   │   └── systemLog.service.js   # write-path for system_log
│   │   └── uploads/
│   │       ├── photos/                # user photos
│   │       └── models/                # model part photos
│   └── python/
│       ├── io_core.py                 # Modbus IOClient: doors, pallet swap, interlocks
│       ├── io_service.py              # Flask wrapper for io_core (:5001)
│       ├── laser_core.py              # LaserClient + full COMMAND_GROUPS reference
│       ├── laser_marker_service.py    # Flask wrapper (job queue + raw command API)
│       └── requirements.txt
├── frontend/
│   ├── login.html                     # sign in / sign up (tabbed)
│   ├── index.html                     # SPA shell: sidebar + topbar + #content
│   ├── css/
│   │   ├── fontawesome/…
│   │   ├── webfonts/…
│   │   ├── base.css
│   │   ├── login.css
│   │   └── dashboard.css
│   ├── js/
│   │   ├── login.js
│   │   └── dashboard.js               # sectioned per page, see comments in-file
│   └── pages/                         # fragments injected into #content
│       ├── monitor.html               # landing page — live pallet monitoring, Production Goal, Complete Setting
│       ├── production_log.html        # admin/engineer — grouped + raw history, CSV export
│       ├── model_setting.html         # admin/engineer/machine_controller — pallet setup + embedded Work Mode
│       ├── add_new_model.html         # admin/engineer — add/edit models + embedded MD-X2520A control panel
│       ├── alarm_center.html          # current/history alarms (mock data pending hardware)
│       ├── profile.html               # self-service profile + "My Production" stats
│       ├── all_user.html              # admin — approve/reject, role changes
│       └── system_log.html            # admin — filterable audit log
├── test/
├── .gitignore
└── README.md
```

## 1. Database

```bash
mysql -u root -p < backend/node/db/schema.sql
```

This creates the `laser_link_md_x` database and every table the app
needs (see the comments in `schema.sql` for what each one is for), plus
a bootstrap admin account:

- Employee ID: `admin`
- Password: `Admin@123`

**Change this password immediately** (Profile page, once signed in).
Every other account (Operator / Machine Controller / Engineer) is
created via Sign Up and must be approved by an admin on the **All
User** page before it can sign in.

> `schema.sql` is fully consolidated — every column that used to be
> added later via a follow-up `ALTER TABLE` is now part of the base
> `CREATE TABLE`. Only run it against a **fresh** database; an existing
> one built from an older copy of this file already has all these
> columns.

## 2. Python equipment service

```bash
cd backend/python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python laser_marker_service.py       # listens on :5000
```

Talks to the MD-X2520A directly over TCP/IP using the ASCII WX/RX
protocol (`laser_core.py`), and runs a background job queue so queued
programs fire one after another with automatic retry on transient
"busy" responses.

## 3. Node API gateway (also serves the frontend)

```bash
cd backend/node
cp .env.example .env   # if you renamed it; otherwise edit .env directly
npm install
npm run dev             # nodemon, or `npm start`
```

Edit `backend/node/.env` with your real MySQL credentials, a proper
`JWT_SECRET`, and the Python service URL if it isn't on
`localhost:5000`.

## 4. Open the app

Visit `http://localhost:4000` — you'll land on the sign-in page. Sign
up for a new account, then have an admin approve it from the **All
User** page before you can sign in.

## Roles & page access

| Page           | admin | engineer | machine_controller | operator |
| -------------- | :---: | :------: | :----------------: | :------: |
| Monitor        |   ✓   |    ✓     |         ✓          |    ✓     |
| Production Log |   ✓   |    ✓     |         —          |    —     |
| Model Setting  |   ✓   |    ✓     |         ✓          |    —     |
| Add New Model  |   ✓   |    ✓     |         —          |    —     |
| Alarm Center   |   ✓   |    ✓     |         ✓          |    ✓     |
| Profile        |   ✓   |    ✓     |         ✓          |    ✓     |
| All User       |   ✓   |    —     |         —          |    —     |
| System Log     |   ✓   |    —     |         —          |    —     |

Enforced both in the UI (`PAGE_ROLES` in `dashboard.js`) and on every
Node API route via `requireRole(...)`.

### Equipment / I-O API access

The Start Marking sequences (Monitor auto cycle, Model Setting manual mode)
run as whoever is signed in — including operators — so the routes they call
are not admin/engineer-only:

| Route                                                                | admin | engineer | machine_controller | operator  |
| -------------------------------------------------------------------- | :---: | :------: | :----------------: | :-------: |
| `/api/io/*` (status, front-door, call-pallet, change-pallet)         |   ✓   |    ✓     |         ✓          |     ✓     |
| `POST /api/equipment/raw`                                            |  any  |   any    |     allowlist      | allowlist |
| other `/api/equipment/*` (commands, status, connect, command, queue) |   ✓   |    ✓     |         —          |     —     |

- **`/api/io/*`** only exposes fixed actions; the real safety interlocks (side
  door, front door closed, pallet alarms, pallet-position preconditions) are
  enforced in `io_core.py`, not by role.
- **`POST /api/equipment/raw`**: admin/engineer may send any command.
  machine_controller / operator may send only the commands the sequences use
  (`RX,Ready`, `WX,JobNo=`, `WX,JOB=…,BLK=…,CharacterString=`,
  `WX,StartMarking=1`, `WX,Check2DCode5=` with 17 params, `RX,CodeReadResult=0|1`),
  and their `ip`/`port` are ignored (the Python service uses its own
  configured laser address). Anything else returns 403 and is logged as
  `equipment.raw_command_denied`. Control characters (`\r`, `\n`) are rejected
  for everyone. See `middleware/equipmentCommandPolicy.js` — if a sequence
  starts sending a new command, add its pattern there.

Within Model Setting / Monitor, `type='setting'` production log entries
are written for admin/engineer/machine_controller, and
`type='mass'` entries only for operator — driven by the acting user's
role at insert time, not by anything the client sends.

## Notes

- The command browser (Add New Model, column 2) is generated entirely
  from `COMMAND_GROUPS` in `backend/python/laser_core.py` and served
  over `/api/equipment/commands` — it covers the full MD-X2000/2500
  series command reference, not just the handful of commands the
  automated sequences use.
- Equipment API routes (`/api/equipment/*`) are guarded to admin/engineer,
  except `POST /raw`, which every role can call within the allowlist above.
  Every state-changing call (connect, raw/command, queue add/clear, I/O
  door/pallet actions) is written to `system_log` for traceability.
  Successful `RX,Ready` polls are not logged (they fire every ~0.5 s while
  waiting for the marker); failed ones are.
- `alarm_center.html` currently runs on mock data — the equipment
  backend for real alarms isn't wired up yet. See the comment block at
  the top of the "FOR ALARM CENTER PAGE" section in `dashboard.js` for
  the exact swap-in points once hardware is connected.
- CSS/JS files are sectioned with `FOR <PAGE NAME>` comments so new
  pages can be added without hunting through unrelated styles/logic.
