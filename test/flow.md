# Architecture

Browser ──HTTP+JWT──► Node :4000 ──► Python laser :5000 ──TCP──► Laser
│ └──► Python I/O :5001 ──Modbus──► Station 1/2
▼
MySQL

Following one request: the laser's Start Marking command

1.  wmRunStartMarking() in dashboard.js calls eqSendRaw().
2.  This becomes POST /api/equipment/raw with a Bearer token.
3.  Node runs requireRole(...), then restrictRawCommand (the allowlist), then forwards through laserService.forward (axios, 90 s timeout).
4.  Flask /api/raw creates a new LaserClient, sends the command, waits for the \r-terminated reply, and closes the socket.
5.  The reply returns to the browser as {ok:true, response:"WX,OK"}.
6.  Node writes a system_log row (except for successful RX,Ready polls, which would flood the log).

7.  Directory map in depth

    ## backend/node/

    1 server.js mounts routes under /api/..., serves /uploads (photos) and the whole frontend/ folder as static files, and returns login.html at /. The final app.use('/api', ...) returns a JSON 404 for unknown API paths.
    2 routes/ contain no logic, only "this URL → this controller → guarded by this role."
    3 controllers/:
    - auth.controller.js: signup, signin, signout, profile, and admin user management.
    - model.controller.js: CRUD for models and conditions, plus the small PATCH endpoints operators use (condition value, lot number, camera toggle).
    - modelQueue.controller.js: per-piece CSV queue and the guardVariableConditions middleware.
    - production.controller.js: logging parts, counts, goals, setting-complete, rework, and "my production" stats.
    - productionLog.controller.js: read-only reporting for the Production Log page.
    - systemLog.controller.js: reading the audit log, plus a generic endpoint for client-side events.
      4 middleware/: requireRole.js (JWT), equipmentCommandPolicy.js (raw-command allowlist), and two multer configs (user photos, model photos, 5 MB limit, JPEG/PNG/WEBP).
      5 services/: two axios wrappers that convert network failures into {status:502} instead of throwing, and systemLog.service.js, which swallows its own errors so a logging failure never breaks the real request.

    ## backend/python/
    - laser_core.py: LaserClient (socket handling, retry on "Busy", RX,Ready polling) and COMMAND_GROUPS, a data structure describing every MD-X command. The Command Browser UI is generated from it, so adding a command means adding a dict entry and nothing else.
    - io_core.py: the signal maps, the safety logic and the pallet-swap choreography.
    - The two \*\_service.py files are thin Flask wrappers.

    ## frontend/
    - index.html is the shell (sidebar, topbar, #content). loadPage(name) fetches pages/<name>.html, injects it into #content, then calls PAGE_INIT[name](). Leaving a page calls PAGE_TEARDOWN[name]() (stops polling timers). Role-restricted pages are listed in PAGE_ROLES, and the sidebar hides links using data-roles attributes.

    This is hand-rolled routing with no framework. When you add a page, you need to touch four places:
    - a new pages/x.html
    - PAGE_TITLES
    - PAGE_INIT (and PAGE_ROLES if restricted)
    - a sidebar button in index.html

    Warning: role checks in the frontend are for appearance only. The real enforcement is requireRole on every route.
