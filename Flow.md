## Architecture

Browser (SPA, vanilla JS)
│ HTTP + JWT
▼
Node/Express gateway :4000 ── serves frontend/ too
│ │
│ ├──► Python laser service :5000 (Flask) ──TCP──► MD-X2520A (10.207.1.202:50002)
│ └──► Python I/O service :5001 (Flask) ──Modbus TCP──► Station 1 + Station 2
▼
MySQL (laser_link_md_x)
