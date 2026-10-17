# Web CAN Utils

A browser-based CAN/CAN FD monitor and transmitter. It talks to GS_USB /
Candlelight-compatible adapters directly through WebUSB, with no driver or
native application required.

## Features

- WebUSB GS_USB / Candlelight support
- Multi-channel CAN and CAN FD monitor
- Transmit panel with periodic send tasks
- Bus timing presets and custom bit-timing registers
- Hardware timestamps, error frames, termination control and debug logging
- Responsive dark/light UI

## Run locally

Serve this directory over HTTP and open `index.html` in a WebUSB-capable browser
(Chrome or Edge):

```sh
python3 -m http.server 8000
# http://localhost:8000/
```

The page must be served from `localhost` or HTTPS for WebUSB to work.

## Tests

```sh
npm install
npm test
```

`test_gsusb.mjs` exercises the adapter against a fake WebUSB device without any
dependencies. `uitest.mjs` drives the real UI with jsdom.

## License

Apache-2.0. See [LICENSE](LICENSE).
