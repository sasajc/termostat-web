# Termostat web

Static web UI for an ESP32 smart thermostat. It talks to the thermostat over MQTT (WSS); broker address, user and password are entered at login and are not part of this repository.

- `index.html`, `app.js`, `style.css`: the app (strict CSP, `wss://` only)
- `vendor/mqtt.min.js`: MQTT.js (MIT licensed), local copy so nothing is loaded from a CDN
