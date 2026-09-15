# HALLAYM Taxi

Premium mobile-first taxi platform built with Node.js, Express, MongoDB-ready storage, Socket.IO and a PWA frontend.

## Roles
- Client: map/address search, fare estimate, taxi request, live status, history, SOS.
- Driver: profile/vehicle data, admin approval, online mode, live orders, accept/status flow, GPS updates.
- Admin: real-time stats, driver approval, users, rides, pricing, blocking, SOS notifications.

## Environment
```env
PORT=10000
JWT_SECRET=replace-with-long-random-secret
MONGODB_URI=mongodb+srv://...
ADMIN_PHONE=+998900000001
ADMIN_PASSWORD=strong-password
APP_NAME=HALLAYM Taxi
```

If `MONGODB_URI` is omitted the app still runs using temporary in-memory storage, intended only for preview/testing.

## Run
```bash
npm install
npm start
```

Health check: `/health`
