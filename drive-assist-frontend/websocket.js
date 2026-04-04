let ws = null;
let wsConnected = false;

function wsUrl() {
  // Dev: same host:port as Vite → proxied to Python (see vite.config.js).
  if (import.meta.env.DEV) {
    const p = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${p}//${window.location.host}/ws`;
  }
  const host = import.meta.env.VITE_WS_HOST ?? '127.0.0.1';
  const port = import.meta.env.VITE_WS_PORT ?? '8765';
  return `ws://${host}:${port}`;
}

export function connectWebSocket(onData, onConnected) {
  try {
    const url = wsUrl();
    ws = new WebSocket(url);

    ws.onopen = () => {
      wsConnected = true;
      console.info('[WS] connected', url);
      onConnected?.();
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        await onData(data);
      } catch (err) {
        console.error('[WS] parse error:', err);
      }
    };

    ws.onclose = () => {
      wsConnected = false;
      setTimeout(() => connectWebSocket(onData, onConnected), 3000);
    };

    ws.onerror = (ev) => {
      wsConnected = false;
      console.warn('[WS] error (will retry):', url, ev);
      // Do not call ws.close() here — it can race the handshake and hide the real error.
    };
  } catch (e) {
    wsConnected = false;
    console.error('[WS] connect exception:', e);
  }
}

export function isConnected() {
  return wsConnected;
}