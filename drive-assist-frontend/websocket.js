let ws = null;
let wsConnected = false;

function wsUrl() {
  if (import.meta.env.DEV) {
    const p = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${p}//${window.location.host}/ws`;
  }
  const host = import.meta.env.VITE_WS_HOST ?? '127.0.0.1';
  const port = import.meta.env.VITE_WS_PORT ?? '8765';
  return `ws://${host}:${port}`;
}

/**
 * @param {function} onData       - called with parsed JSON payload
 * @param {function} [onConnected] - called when socket opens
 * @param {function} [onDisconnected] - called when socket closes / errors
 */
export function connectWebSocket(onData, onConnected, onDisconnected) {
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
      onDisconnected?.();
      setTimeout(() => connectWebSocket(onData, onConnected, onDisconnected), 3000);
    };

    ws.onerror = () => {
      wsConnected = false;
      onDisconnected?.();
    };
  } catch (e) {
    wsConnected = false;
    console.error('[WS] connect exception:', e);
    onDisconnected?.();
  }
}

export function isConnected() {
  return wsConnected;
}