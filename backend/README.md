# SCRB AI Investigation Backend - Node.js

This folder contains a dependency-free Node.js backend for the existing investigation copilot UI.

## Run

```powershell
cd backend
npm start
```

Default URL:

```text
http://127.0.0.1:8000/
```

If the Python server is already using port 8000, run Node on another port:

```powershell
$env:PORT=8001
npm start
```

## Test

```powershell
cd backend
npm test
```

## API Coverage

- `GET /api/health`
- `GET /api/summary`
- `POST /api/auth/login`
- `GET /api/analytics`
- `GET /api/linkage`
- `GET /api/audit`
- `POST /api/chat`
- `POST /api/agent/run`
- `POST /api/copilot/brief`
- `POST /api/report`
- `POST /api/export`

The server also serves the existing frontend from `../public`.
